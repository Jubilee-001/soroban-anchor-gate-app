package relay_test

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	_ "github.com/lib/pq"
	"github.com/soroban-anchor-gate/relay/internal/listener"
	"github.com/soroban-anchor-gate/relay/internal/store"
	"github.com/soroban-anchor-gate/relay/internal/store/migrations"
)

const (
	haContractID = "CBIHLECKLMXYK6FPHSGGVYF6AHNFRHR3T5EIFIS3PFQDFKDQWNR25PHT"
	// Canonical ScVal vector: (profile_hash: BytesN<32>, payout_amount: i128).
	// Copied from the authoritative Stellar SDK events used by listener tests.
	haValueXDR = "AAAAEAAAAAEAAAACAAAADQAAACABI0VniavN7wEjRWeJq83vASNFZ4mrze8BI0VniavN7wAAAAoAAAAAAAAAAAAAAAAAlYlA"
)

func haLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// pgSharedStore is the PostgreSQL coordination adapter used by the two replica
// harnesses. It deliberately lives in the test package: this issue verifies
// the row-level-locking contract that a sharedIdempotencyStore backend must
// provide, without changing the daemon's production store selection.
//
// The claim is a single atomic conditional upsert against the processed_events
// primary key. PostgreSQL locks the matching row for the winner; concurrent
// claimers block, re-evaluate the WHERE clause after the winner commits, and
// observe the processing (or completed) state instead of claiming again.
type pgSharedStore struct {
	db                 *sql.DB
	defaultStartLedger uint32
}

func newPGSharedStore(db *sql.DB, defaultStartLedger uint32) *pgSharedStore {
	return &pgSharedStore{db: db, defaultStartLedger: defaultStartLedger}
}

const pgObserveSQL = `
	INSERT INTO processed_events (event_id, state, updated_at)
	VALUES ($1, 'observed', $2)
	ON CONFLICT (event_id) DO UPDATE
	SET state = 'observed', updated_at = EXCLUDED.updated_at, error = NULL
	WHERE processed_events.state IN ('observed', 'failed')
	RETURNING state`

const pgClaimSQL = `
	INSERT INTO processed_events (event_id, state, updated_at)
	VALUES ($1, 'processing', $2)
	ON CONFLICT (event_id) DO UPDATE
	SET state = 'processing', updated_at = EXCLUDED.updated_at, error = NULL
	WHERE processed_events.state NOT IN ('completed', 'processing')
	RETURNING state`

const pgCompleteSQL = `
	INSERT INTO processed_events (event_id, state, updated_at)
	VALUES ($1, 'completed', $2)
	ON CONFLICT (event_id) DO UPDATE
	SET state = 'completed', updated_at = EXCLUDED.updated_at, error = NULL
	WHERE processed_events.state <> 'completed'
	RETURNING state`

func (s *pgSharedStore) IsProcessed(eventID string) bool {
	state, ok := s.GetEventState(eventID)
	return ok && state == store.StateCompleted
}

func (s *pgSharedStore) GetEventState(eventID string) (store.ProcessingState, bool) {
	var state store.ProcessingState
	err := s.db.QueryRowContext(context.Background(),
		`SELECT state FROM processed_events WHERE event_id = $1`, eventID).Scan(&state)
	if err != nil {
		return "", false
	}
	return state, true
}

func (s *pgSharedStore) RecordObserved(eventID string) error {
	var state store.ProcessingState
	err := s.db.QueryRowContext(context.Background(), pgObserveSQL, eventID, time.Now().Unix()).Scan(&state)
	if err == nil {
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("record observed event %s: %w", eventID, err)
	}

	existing, ok := s.GetEventState(eventID)
	if ok && existing == store.StateCompleted {
		return fmt.Errorf("event %s already completed", eventID)
	}
	// Another replica owns the event; observe must not steal it.
	return nil
}

func (s *pgSharedStore) ClaimForProcessing(eventID string) error {
	var state store.ProcessingState
	err := s.db.QueryRowContext(context.Background(), pgClaimSQL, eventID, time.Now().Unix()).Scan(&state)
	if err == nil {
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("claim event %s: %w", eventID, err)
	}

	existing, ok := s.GetEventState(eventID)
	switch {
	case ok && existing == store.StateCompleted:
		return fmt.Errorf("event %s already completed", eventID)
	case ok && existing == store.StateProcessing:
		return fmt.Errorf("event %s is currently being processed", eventID)
	default:
		return fmt.Errorf("event %s could not be claimed", eventID)
	}
}

func (s *pgSharedStore) MarkCompleted(eventID string) error {
	var state store.ProcessingState
	err := s.db.QueryRowContext(context.Background(), pgCompleteSQL, eventID, time.Now().Unix()).Scan(&state)
	if err == nil {
		return nil
	}
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("event %s already completed", eventID)
	}
	return fmt.Errorf("mark event %s completed: %w", eventID, err)
}

func (s *pgSharedStore) MarkFailed(eventID string, reason string) error {
	_, err := s.db.ExecContext(context.Background(), `
		INSERT INTO processed_events (event_id, state, updated_at, error)
		VALUES ($1, 'failed', $2, $3)
		ON CONFLICT (event_id) DO UPDATE
		SET state = 'failed', updated_at = EXCLUDED.updated_at, error = EXCLUDED.error`,
		eventID, time.Now().Unix(), reason)
	if err != nil {
		return fmt.Errorf("mark event %s failed: %w", eventID, err)
	}
	return nil
}

func (s *pgSharedStore) MarkProcessed(eventID string) error {
	return s.MarkCompleted(eventID)
}

func (s *pgSharedStore) GetCursor() uint32 {
	var ledger int64
	err := s.db.QueryRowContext(context.Background(),
		`SELECT last_ledger FROM relay_cursor WHERE id = 1`).Scan(&ledger)
	if err != nil || ledger < 0 {
		return s.defaultStartLedger
	}
	return uint32(ledger)
}

func (s *pgSharedStore) SetCursor(ledger uint32) error {
	var stored int64
	err := s.db.QueryRowContext(context.Background(), `
		INSERT INTO relay_cursor (id, last_ledger)
		VALUES (1, $1)
		ON CONFLICT (id) DO UPDATE
		SET last_ledger = EXCLUDED.last_ledger
		WHERE relay_cursor.last_ledger <= EXCLUDED.last_ledger
		RETURNING last_ledger`, int64(ledger)).Scan(&stored)
	if err == nil {
		return nil
	}
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("cursor cannot regress from %d to %d", s.GetCursor(), ledger)
	}
	return fmt.Errorf("set cursor to %d: %w", ledger, err)
}

func (s *pgSharedStore) Count() int {
	var count int
	if err := s.db.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM processed_events`).Scan(&count); err != nil {
		return 0
	}
	return count
}

func (s *pgSharedStore) ListAll() []store.EventRecord {
	rows, err := s.db.QueryContext(context.Background(),
		`SELECT event_id, state, updated_at, COALESCE(error, '') FROM processed_events ORDER BY event_id`)
	if err != nil {
		return nil
	}
	defer rows.Close()

	var records []store.EventRecord
	for rows.Next() {
		var rec store.EventRecord
		if err := rows.Scan(&rec.EventID, &rec.State, &rec.UpdatedAt, &rec.Error); err != nil {
			return nil
		}
		records = append(records, rec)
	}
	return records
}

func (s *pgSharedStore) Close() error {
	return s.db.Close()
}

// newHADatabase creates an isolated PostgreSQL schema for one test. The test is
// skipped when no PostgreSQL connection string is configured, matching the
// existing relay Postgres integration test convention.
func newHADatabase(t *testing.T) string {
	t.Helper()

	baseDSN := os.Getenv("POSTGRES_URL")
	if baseDSN == "" {
		baseDSN = os.Getenv("DATABASE_URL")
	}
	if baseDSN == "" {
		t.Skip("HA integration test skipped: set POSTGRES_URL or DATABASE_URL to run against PostgreSQL")
	}

	admin, err := sql.Open("postgres", baseDSN)
	if err != nil {
		t.Skipf("cannot open PostgreSQL connection: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := admin.PingContext(ctx); err != nil {
		_ = admin.Close()
		t.Skipf("PostgreSQL not reachable: %v", err)
	}

	schema := fmt.Sprintf("ha_test_%d", time.Now().UnixNano())
	if _, err := admin.ExecContext(ctx, "CREATE SCHEMA "+schema); err != nil {
		_ = admin.Close()
		t.Fatalf("create isolated schema: %v", err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec("DROP SCHEMA IF EXISTS " + schema + " CASCADE")
		_ = admin.Close()
	})

	return withSearchPath(baseDSN, schema)
}

// withSearchPath scopes every pooled connection to the isolated test schema.
func withSearchPath(dsn, schema string) string {
	if strings.Contains(dsn, "://") {
		separator := "?"
		if strings.Contains(dsn, "?") {
			separator = "&"
		}
		return dsn + separator + "search_path=" + url.QueryEscape(schema)
	}
	return dsn + " search_path=" + schema
}

// openReplicaDB opens a distinct connection pool, emulating a separate relay
// process that shares the same physical database.
func openReplicaDB(t *testing.T, dsn string) *sql.DB {
	t.Helper()

	db, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatalf("open replica database: %v", err)
	}
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(8)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		t.Fatalf("ping replica database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func migrateHADatabase(t *testing.T, db *sql.DB) {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := migrations.NewMigrator(db, haLogger()).RunPending(ctx); err != nil {
		t.Fatalf("run migrations: %v", err)
	}
}

// escrowTopicXDR encodes the u64 escrow ID topic the relay decodes.
func escrowTopicXDR(escrowID uint64) string {
	buf := make([]byte, 12)
	binary.BigEndian.PutUint32(buf[0:4], 5) // ScvU64
	binary.BigEndian.PutUint64(buf[4:12], escrowID)
	return base64.StdEncoding.EncodeToString(buf)
}

// fakeRPC serves the same disbursed events on every poll, exactly like an RPC
// node that both replicas query concurrently.
type fakeRPC struct {
	mu    sync.Mutex
	items []listener.EventItem
	polls int
}

func (f *fakeRPC) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	var req struct {
		Method string `json:"method"`
	}
	_ = json.Unmarshal(body, &req)

	w.Header().Set("Content-Type", "application/json")
	switch req.Method {
	case "getLatestLedger":
		_, _ = fmt.Fprintf(w, `{"jsonrpc":"2.0","id":1,"result":{"id":"ha","protocolVersion":22,"sequence":500}}`)
	case "getEvents":
		f.mu.Lock()
		f.polls++
		f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"jsonrpc": "2.0",
			"id":      1,
			"result": map[string]interface{}{
				"events":       f.items,
				"latestLedger": 500,
			},
		})
	default:
		http.Error(w, "unknown method", http.StatusBadRequest)
	}
}

func (f *fakeRPC) pollCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.polls
}

// anchorStub emulates the external anchor banking endpoint and records every
// payout request it receives, keyed by event ID and escrow ID.
type anchorStub struct {
	mu       sync.Mutex
	byEvent  map[string]int
	byEscrow map[uint64]int
	delay    time.Duration
}

func newAnchorStub(delay time.Duration) *anchorStub {
	return &anchorStub{
		byEvent:  make(map[string]int),
		byEscrow: make(map[uint64]int),
		delay:    delay,
	}
}

func (a *anchorStub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	eventID := r.URL.Query().Get("event_id")
	escrowID, err := strconv.ParseUint(r.URL.Query().Get("escrow_id"), 10, 64)
	if err != nil || eventID == "" {
		http.Error(w, "missing event_id or escrow_id", http.StatusBadRequest)
		return
	}

	// Hold the request open briefly to widen the window in which overlapping
	// replicas could otherwise both disburse the same event.
	if a.delay > 0 {
		time.Sleep(a.delay)
	}

	a.mu.Lock()
	a.byEvent[eventID]++
	a.byEscrow[escrowID]++
	a.mu.Unlock()

	w.WriteHeader(http.StatusOK)
}

func (a *anchorStub) snapshot() (map[string]int, map[uint64]int, int) {
	a.mu.Lock()
	defer a.mu.Unlock()

	events := make(map[string]int, len(a.byEvent))
	for k, v := range a.byEvent {
		events[k] = v
	}
	escrows := make(map[uint64]int, len(a.byEscrow))
	for k, v := range a.byEscrow {
		escrows[k] = v
	}
	return events, escrows, len(a.byEvent)
}

// relayReplica mirrors the daemon's production pipeline: a poller backed by a
// shared store, a processing loop, and an anchor payout call.
type relayReplica struct {
	name      string
	db        *sql.DB
	store     store.IdempotencyStore
	sub       *listener.EventSubscriber
	anchorURL string
	logger    *slog.Logger
}

func (r *relayReplica) run(ctx context.Context, wg *sync.WaitGroup) {
	defer wg.Done()

	events := make(chan listener.EventPayload, 100)
	go func() {
		if err := r.sub.PollEvents(ctx, events); err != nil && !errors.Is(err, context.Canceled) {
			r.logger.Error("poller stopped", "replica", r.name, "error", err)
		}
	}()

	client := &http.Client{Timeout: 10 * time.Second}
	for {
		select {
		case payload, ok := <-events:
			if !ok {
				return
			}
			r.disburse(ctx, client, payload)
		case <-ctx.Done():
			return
		}
	}
}

func (r *relayReplica) disburse(ctx context.Context, client *http.Client, payload listener.EventPayload) {
	endpoint := fmt.Sprintf("%s/payout?event_id=%s&escrow_id=%d",
		r.anchorURL, url.QueryEscape(payload.EventID), payload.EscrowID)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, nil)
	if err != nil {
		r.logger.Error("build payout request", "replica", r.name, "event_id", payload.EventID, "error", err)
		return
	}
	resp, err := client.Do(req)
	if err != nil {
		r.logger.Error("anchor payout failed", "replica", r.name, "event_id", payload.EventID, "error", err)
		return
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		r.logger.Error("anchor payout rejected", "replica", r.name, "event_id", payload.EventID, "status", resp.StatusCode)
		return
	}

	if err := r.store.MarkCompleted(payload.EventID); err != nil {
		r.logger.Error("mark completed failed", "replica", r.name, "event_id", payload.EventID, "error", err)
	}
}

// TestPostgresStore_ConcurrentClaimSingleWinner verifies the database
// row-level locking primitive directly: many replicas race to claim the same
// event and exactly one succeeds.
func TestPostgresStore_ConcurrentClaimSingleWinner(t *testing.T) {
	dsn := newHADatabase(t)
	baseDB := openReplicaDB(t, dsn)
	migrateHADatabase(t, baseDB)

	const replicas = 4
	stores := make([]*pgSharedStore, replicas)
	for i := 0; i < replicas; i++ {
		stores[i] = newPGSharedStore(openReplicaDB(t, dsn), 500)
	}

	const eventID = "0000000500-0000000001"
	start := make(chan struct{})
	var wg sync.WaitGroup
	var mu sync.Mutex
	var winners []int
	var loserErrs []error

	for i := 0; i < replicas; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			<-start
			err := stores[idx].ClaimForProcessing(eventID)
			mu.Lock()
			defer mu.Unlock()
			if err == nil {
				winners = append(winners, idx)
			} else {
				loserErrs = append(loserErrs, err)
			}
		}(i)
	}
	close(start)
	wg.Wait()

	if len(winners) != 1 {
		t.Fatalf("expected exactly one claim winner, got %d (winners=%v, errors=%v)", len(winners), winners, loserErrs)
	}
	for _, err := range loserErrs {
		if !strings.Contains(err.Error(), "currently being processed") {
			t.Errorf("expected claim conflict error, got %v", err)
		}
	}

	// A second observation from a losing poller must not steal ownership.
	if err := stores[0].RecordObserved(eventID); err != nil {
		t.Fatalf("RecordObserved on a processing event returned error: %v", err)
	}
	state, ok := stores[0].GetEventState(eventID)
	if !ok || state != store.StateProcessing {
		t.Fatalf("expected processing state to be preserved, got %q (ok=%v)", state, ok)
	}

	winner := stores[winners[0]]
	if err := winner.MarkCompleted(eventID); err != nil {
		t.Fatalf("winner failed to complete event: %v", err)
	}

	// Once completed, no replica may claim or re-complete the event.
	if err := stores[(winners[0]+1)%replicas].ClaimForProcessing(eventID); err == nil ||
		!strings.Contains(err.Error(), "already completed") {
		t.Fatalf("expected already-completed claim error, got %v", err)
	}
	if err := winner.MarkCompleted(eventID); err == nil {
		t.Fatal("expected duplicate completion to be rejected")
	}
	if got := winner.Count(); got != 1 {
		t.Fatalf("expected one shared event record, got %d", got)
	}
}

// TestPostgresStore_ConcurrentCursorMonotonic verifies that replicas sharing a
// cursor cannot move it backwards.
func TestPostgresStore_ConcurrentCursorMonotonic(t *testing.T) {
	dsn := newHADatabase(t)
	baseDB := openReplicaDB(t, dsn)
	migrateHADatabase(t, baseDB)

	stores := []*pgSharedStore{
		newPGSharedStore(openReplicaDB(t, dsn), 100),
		newPGSharedStore(openReplicaDB(t, dsn), 100),
	}

	ledgers := []uint32{120, 90, 150, 140}
	var wg sync.WaitGroup
	for i, ledger := range ledgers {
		wg.Add(1)
		go func(idx int, l uint32) {
			defer wg.Done()
			_ = stores[idx%len(stores)].SetCursor(l)
		}(i, ledger)
	}
	wg.Wait()

	if got := stores[0].GetCursor(); got != 150 {
		t.Fatalf("expected cursor to settle at highest ledger 150, got %d", got)
	}
	if err := stores[1].SetCursor(110); err == nil {
		t.Fatal("expected cursor regression to be rejected")
	}
}

// TestRelayReplicas_NoDuplicatePayoutsDuringRollingDeploy is the end-to-end
// rolling deployment check. Two independent relay replicas poll the same
// Soroban event feed against the same PostgreSQL database while a new replica
// overlaps the old one. Every event must produce exactly one anchor payout.
func TestRelayReplicas_NoDuplicatePayoutsDuringRollingDeploy(t *testing.T) {
	dsn := newHADatabase(t)
	baseDB := openReplicaDB(t, dsn)
	migrateHADatabase(t, baseDB)

	const eventCount = 5
	items := make([]listener.EventItem, 0, eventCount)
	for i := 0; i < eventCount; i++ {
		items = append(items, listener.EventItem{
			ID:                       fmt.Sprintf("0000000500-%010d", i+1),
			Type:                     "contract",
			Ledger:                   500,
			ContractID:               haContractID,
			Topic:                    []string{"AAAADwAAAAlkaXNidXJzZWQAAAA=", escrowTopicXDR(uint64(1000 + i))},
			Value:                    listener.EventValue{XDR: haValueXDR},
			InSuccessfulContractCall: true,
		})
	}

	rpc := &fakeRPC{items: items}
	rpcServer := httptest.NewServer(rpc)
	defer rpcServer.Close()

	anchor := newAnchorStub(20 * time.Millisecond)
	anchorServer := httptest.NewServer(anchor)
	defer anchorServer.Close()

	// Two replicas, each with its own connection pool, sharing one database.
	replicas := []*relayReplica{
		{
			name:      "relay-old-pod",
			db:        openReplicaDB(t, dsn),
			anchorURL: anchorServer.URL,
			logger:    haLogger(),
		},
		{
			name:      "relay-new-pod",
			db:        openReplicaDB(t, dsn),
			anchorURL: anchorServer.URL,
			logger:    haLogger(),
		},
	}
	for _, replica := range replicas {
		replica.store = newPGSharedStore(replica.db, 500)
		replica.sub = listener.NewEventSubscriber(rpcServer.URL, haContractID, replica.store, replica.logger)
	}

	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	for _, replica := range replicas {
		wg.Add(1)
		go replica.run(ctx, &wg)
	}
	defer func() {
		cancel()
		wg.Wait()
	}()

	// Wait for both replicas to poll and process the full window. PollEvents
	// uses a 4s ticker, so allow the first poll cycle plus processing time.
	deadline := time.Now().Add(15 * time.Second)
	var total int
	for time.Now().Before(deadline) {
		_, _, total = anchor.snapshot()
		if total == eventCount {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	if total != eventCount {
		events, _, _ := anchor.snapshot()
		t.Fatalf("expected %d anchor payouts, observed %d: %v", eventCount, total, events)
	}

	// Give a duplicate claim a chance to surface before cancelling.
	time.Sleep(500 * time.Millisecond)
	cancel()
	wg.Wait()

	byEvent, byEscrow, totalPayouts := anchor.snapshot()
	if totalPayouts != eventCount {
		t.Fatalf("expected exactly %d disbursed events, got %d: %v", eventCount, totalPayouts, byEvent)
	}
	for _, item := range items {
		if got := byEvent[item.ID]; got != 1 {
			t.Errorf("event %s disbursed %d times, want exactly 1", item.ID, got)
		}
	}
	for escrowID, count := range byEscrow {
		if count != 1 {
			t.Errorf("escrow %d disbursed %d times, want exactly 1", escrowID, count)
		}
	}

	// Both replicas must agree on the shared, terminal state.
	for _, item := range items {
		var state store.ProcessingState
		if err := baseDB.QueryRow(`SELECT state FROM processed_events WHERE event_id = $1`, item.ID).Scan(&state); err != nil {
			t.Fatalf("read shared state for %s: %v", item.ID, err)
		}
		if state != store.StateCompleted {
			t.Errorf("event %s state = %q, want %q", item.ID, state, store.StateCompleted)
		}
	}

	// Both replicas polled the same feed, proving the overlap actually occurred.
	if polls := rpc.pollCount(); polls < 2 {
		t.Fatalf("expected both replicas to poll the shared feed, got %d polls", polls)
	}
}
