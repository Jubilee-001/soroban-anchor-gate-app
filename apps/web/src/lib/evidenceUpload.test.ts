import assert from "node:assert";
import { describe, test } from "node:test";
import { createHash } from "node:crypto";
import {
  MAX_FILE_SIZE,
  ALLOWED_MIME_TYPES,
  ALLOWED_EXTENSIONS,
  validateEvidenceFile,
  computeFileSha256,
  toBase58,
  generateIpfsCid,
  generateArweaveId,
  createEvidenceMetadata,
  toDisputeEvidence,
  pinEvidenceFile,
  evidenceUploadReducer,
  initialEvidenceUploadState,
  formatFileSize,
  type DisputeEvidenceMetadata,
  type EvidenceFileDetails,
} from "../components/EvidenceUpload";
import { disputeReducer, initialDisputeState } from "../components/DisputeSlider";

describe("Dispute Evidence File Validation", () => {
  test("exports valid ALLOWED_MIME_TYPES and ALLOWED_EXTENSIONS constants", () => {
    assert.ok(ALLOWED_MIME_TYPES.includes("image/png"));
    assert.ok(ALLOWED_MIME_TYPES.includes("image/jpeg"));
    assert.ok(ALLOWED_MIME_TYPES.includes("application/pdf"));
    assert.ok(ALLOWED_EXTENSIONS.includes(".png"));
    assert.ok(ALLOWED_EXTENSIONS.includes(".jpg"));
    assert.ok(ALLOWED_EXTENSIONS.includes(".jpeg"));
    assert.ok(ALLOWED_EXTENSIONS.includes(".pdf"));
  });

  test("accepts valid PNG, JPEG, and PDF files within 5MB limit", () => {
    const validPng = { name: "receipt.png", size: 1024 * 1024, type: "image/png" };
    const validJpg = { name: "invoice.jpg", size: 2 * 1024 * 1024, type: "image/jpeg" };
    const validPdf = { name: "contract.pdf", size: 4.9 * 1024 * 1024, type: "application/pdf" };
    const exactMax = { name: "max.png", size: MAX_FILE_SIZE, type: "image/png" };

    assert.strictEqual(validateEvidenceFile(validPng).valid, true);
    assert.strictEqual(validateEvidenceFile(validJpg).valid, true);
    assert.strictEqual(validateEvidenceFile(validPdf).valid, true);
    assert.strictEqual(validateEvidenceFile(exactMax).valid, true);
  });

  test("rejects files exceeding the 5MB boundary", () => {
    const overLimit = {
      name: "huge_scan.pdf",
      size: MAX_FILE_SIZE + 1,
      type: "application/pdf",
    };
    const tenMb = {
      name: "video.png",
      size: 10 * 1024 * 1024,
      type: "image/png",
    };

    const res1 = validateEvidenceFile(overLimit);
    assert.strictEqual(res1.valid, false);
    assert.ok(res1.error?.includes("exceeds maximum allowed limit of 5 MB"));

    const res2 = validateEvidenceFile(tenMb);
    assert.strictEqual(res2.valid, false);
    assert.ok(res2.error?.includes("exceeds maximum allowed limit"));
  });

  test("rejects empty files (0 bytes)", () => {
    const empty = { name: "empty.pdf", size: 0, type: "application/pdf" };
    const res = validateEvidenceFile(empty);
    assert.strictEqual(res.valid, false);
    assert.ok(res.error?.includes("empty"));
  });

  test("rejects unsupported MIME types and extensions", () => {
    const unsupported = [
      { name: "script.js", size: 1024, type: "application/javascript" },
      { name: "executable.exe", size: 2048, type: "application/x-msdownload" },
      { name: "archive.zip", size: 4096, type: "application/zip" },
      { name: "document.docx", size: 4096, type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      { name: "audio.mp3", size: 1024, type: "audio/mpeg" },
    ];

    for (const file of unsupported) {
      const res = validateEvidenceFile(file);
      assert.strictEqual(res.valid, false);
      assert.ok(res.error?.includes("Unsupported file type"));
    }
  });

  test("handles missing or null input gracefully", () => {
    assert.strictEqual(validateEvidenceFile(null).valid, false);
    assert.strictEqual(validateEvidenceFile(undefined).valid, false);
  });

  test("matches allowed extensions fallback when MIME is generic octet-stream", () => {
    const fileWithGenericMime = {
      name: "statement.pdf",
      size: 1024,
      type: "application/octet-stream",
    };
    assert.strictEqual(validateEvidenceFile(fileWithGenericMime).valid, true);
  });
});

describe("Client-side SHA-256 Hash Computation", () => {
  test("computes deterministic 64-character hex hash matching Node.js crypto", async () => {
    const testData = new TextEncoder().encode("Evidence milestone invoice #1024 payment receipt proof");
    const computedHash = await computeFileSha256(testData);

    const expectedHash = createHash("sha256").update(testData).digest("hex");

    assert.strictEqual(computedHash, expectedHash);
    assert.strictEqual(computedHash.length, 64);
    assert.match(computedHash, /^[0-9a-f]{64}$/);
  });

  test("different file data produces distinct SHA-256 hashes", async () => {
    const dataA = new TextEncoder().encode("Evidence file version 1");
    const dataB = new TextEncoder().encode("Evidence file version 2");

    const hashA = await computeFileSha256(dataA);
    const hashB = await computeFileSha256(dataB);

    assert.notStrictEqual(hashA, hashB);
    assert.strictEqual(hashA.length, 64);
    assert.strictEqual(hashB.length, 64);
  });

  test("handles empty Uint8Array buffer", async () => {
    const emptyData = new Uint8Array(0);
    const computedHash = await computeFileSha256(emptyData);
    const expectedHash = createHash("sha256").update(emptyData).digest("hex");

    assert.strictEqual(computedHash, expectedHash);
  });
});

describe("Decentralized Storage Identifiers (IPFS CID & Arweave ID)", () => {
  test("generateIpfsCid produces standard 46-character CIDv0 starting with Qm", () => {
    const sampleHex = createHash("sha256").update("dispute evidence test data").digest("hex");
    const cid = generateIpfsCid(sampleHex);

    assert.strictEqual(typeof cid, "string");
    assert.strictEqual(cid.length, 46);
    assert.ok(cid.startsWith("Qm"), `Expected CID to start with Qm, got: ${cid}`);
  });

  test("generateIpfsCid is deterministic for identical inputs", () => {
    const hex = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const cid1 = generateIpfsCid(hex);
    const cid2 = generateIpfsCid(hex);

    assert.strictEqual(cid1, cid2);
  });

  test("generateIpfsCid rejects invalid SHA-256 hex strings", () => {
    assert.throws(() => generateIpfsCid("too-short"), /Invalid SHA-256 hex string/);
    assert.throws(() => generateIpfsCid("not-hex-chars-123456789012345678901234567890123456789012345678901234"), /Invalid SHA-256 hex string/);
  });

  test("generateArweaveId produces 43-character base64url transaction reference", () => {
    const hex = createHash("sha256").update("arweave test data").digest("hex");
    const arId = generateArweaveId(hex);

    assert.strictEqual(typeof arId, "string");
    assert.strictEqual(arId.length, 43);
    assert.match(arId, /^[A-Za-z0-9_-]{43}$/);
  });

  test("toBase58 handles leading zero bytes properly", () => {
    const bytes = new Uint8Array([0, 0, 1, 2, 3]);
    const encoded = toBase58(bytes);
    assert.ok(encoded.startsWith("11"), "Leading zeros in byte array should map to '1's in Base58");
  });
});

describe("Dispute Evidence Metadata Management", () => {
  const sampleFile: EvidenceFileDetails = {
    name: "invoice-october.pdf",
    size: 204800,
    type: "application/pdf",
  };
  const sampleHash = "a".repeat(64);

  test("createEvidenceMetadata constructs complete IPFS metadata record", () => {
    const meta = createEvidenceMetadata({
      file: sampleFile,
      sha256: sampleHash,
      description: "October milestone billing statement",
      storageProvider: "ipfs",
    });

    assert.strictEqual(meta.name, "invoice-october.pdf");
    assert.strictEqual(meta.size, 204800);
    assert.strictEqual(meta.type, "application/pdf");
    assert.strictEqual(meta.sha256, sampleHash);
    assert.ok(meta.cid.startsWith("Qm"));
    assert.strictEqual(meta.ipfsUri, `ipfs://${meta.cid}`);
    assert.strictEqual(meta.gatewayUrl, `https://ipfs.io/ipfs/${meta.cid}`);
    assert.strictEqual(meta.description, "October milestone billing statement");
    assert.strictEqual(meta.storageProvider, "ipfs");
    assert.ok(meta.id.startsWith("ev_"));
    assert.ok(new Date(meta.uploadedAt).getTime() > 0);
  });

  test("createEvidenceMetadata supports Arweave decentralized storage provider", () => {
    const meta = createEvidenceMetadata({
      file: sampleFile,
      sha256: sampleHash,
      storageProvider: "arweave",
    });

    assert.strictEqual(meta.storageProvider, "arweave");
    assert.strictEqual(meta.ipfsUri, `ar://${meta.cid}`);
    assert.strictEqual(meta.gatewayUrl, `https://arweave.net/${meta.cid}`);
  });

  test("toDisputeEvidence maps metadata to DisputeSlider evidence structure", () => {
    const meta = createEvidenceMetadata({
      file: sampleFile,
      sha256: sampleHash,
      description: "Signed delivery note",
    });

    const ref = toDisputeEvidence(meta);
    assert.strictEqual(ref.url, meta.gatewayUrl);
    assert.strictEqual(ref.description, "Signed delivery note");
  });

  test("formatFileSize converts bytes to readable scale", () => {
    assert.strictEqual(formatFileSize(0), "0 B");
    assert.strictEqual(formatFileSize(512), "512 B");
    assert.strictEqual(formatFileSize(1024), "1.0 KB");
    assert.strictEqual(formatFileSize(1536), "1.5 KB");
    assert.strictEqual(formatFileSize(1024 * 1024), "1.00 MB");
    assert.strictEqual(formatFileSize(5 * 1024 * 1024), "5.00 MB");
  });
});

describe("Pinning Service Logic", () => {
  const sampleFile: EvidenceFileDetails = {
    name: "receipt.png",
    size: 50000,
    type: "image/png",
  };
  const sha256 = createHash("sha256").update("receipt bytes").digest("hex");
  const rawBytes = new Uint8Array([1, 2, 3, 4, 5]);

  test("pinEvidenceFile uses deterministic pinning when no endpoint provided", async () => {
    const metadata = await pinEvidenceFile({
      file: rawBytes,
      fileDetails: sampleFile,
      sha256,
      description: "Bank transfer slip",
      storageProvider: "ipfs",
    });

    assert.ok(metadata.cid.startsWith("Qm"));
    assert.strictEqual(metadata.name, "receipt.png");
    assert.strictEqual(metadata.description, "Bank transfer slip");
  });

  test("pinEvidenceFile accepts custom pinFn injection", async () => {
    const customCid = "QmCustomMockCid123456789012345678901234567890";
    const metadata = await pinEvidenceFile({
      file: rawBytes,
      fileDetails: sampleFile,
      sha256,
      pinFn: async (details, hash) => {
        assert.strictEqual(details.name, "receipt.png");
        assert.strictEqual(hash, sha256);
        return { cid: customCid };
      },
    });

    assert.strictEqual(metadata.cid, customCid);
  });
});

describe("EvidenceUpload State Machine & Reducer", () => {
  const baseState = initialEvidenceUploadState();
  const sampleFile: EvidenceFileDetails = {
    name: "dispute_doc.pdf",
    size: 1048576,
    type: "application/pdf",
  };
  const sampleSha = "b".repeat(64);

  test("initial state is idle with 0 progress and null fields", () => {
    assert.strictEqual(baseState.status, "idle");
    assert.strictEqual(baseState.progress, 0);
    assert.strictEqual(baseState.file, null);
    assert.strictEqual(baseState.sha256, null);
    assert.strictEqual(baseState.cid, null);
    assert.strictEqual(baseState.metadata, null);
    assert.strictEqual(baseState.error, null);
  });

  test("SELECT_FILE sets file details and validating status", () => {
    const state = evidenceUploadReducer(baseState, {
      type: "SELECT_FILE",
      file: sampleFile,
    });
    assert.strictEqual(state.status, "validating");
    assert.deepStrictEqual(state.file, sampleFile);
    assert.strictEqual(state.error, null);
  });

  test("START_HASHING transitions to hashing with 25% progress", () => {
    const state = evidenceUploadReducer(baseState, { type: "START_HASHING" });
    assert.strictEqual(state.status, "hashing");
    assert.strictEqual(state.progress, 25);
  });

  test("HASH_SUCCESS transitions to idle with sha256 recorded", () => {
    const hashingState = evidenceUploadReducer(baseState, { type: "START_HASHING" });
    const state = evidenceUploadReducer(hashingState, {
      type: "HASH_SUCCESS",
      sha256: sampleSha,
    });
    assert.strictEqual(state.status, "idle");
    assert.strictEqual(state.sha256, sampleSha);
    assert.strictEqual(state.progress, 50);
  });

  test("START_UPLOADING and SET_PROGRESS update progress", () => {
    let state = evidenceUploadReducer(baseState, { type: "START_UPLOADING" });
    assert.strictEqual(state.status, "uploading");
    assert.strictEqual(state.progress, 60);

    state = evidenceUploadReducer(state, { type: "SET_PROGRESS", progress: 85 });
    assert.strictEqual(state.progress, 85);
  });

  test("UPLOAD_SUCCESS records metadata, CID, and sets 100% progress", () => {
    const metadata: DisputeEvidenceMetadata = createEvidenceMetadata({
      file: sampleFile,
      sha256: sampleSha,
      description: "Uploaded invoice",
    });

    const state = evidenceUploadReducer(baseState, {
      type: "UPLOAD_SUCCESS",
      metadata,
    });

    assert.strictEqual(state.status, "success");
    assert.strictEqual(state.progress, 100);
    assert.deepStrictEqual(state.metadata, metadata);
    assert.strictEqual(state.cid, metadata.cid);
    assert.strictEqual(state.error, null);
  });

  test("SET_ERROR records error and transitions to error status", () => {
    const state = evidenceUploadReducer(baseState, {
      type: "SET_ERROR",
      error: "Pinning failed: timeout",
    });
    assert.strictEqual(state.status, "error");
    assert.strictEqual(state.error, "Pinning failed: timeout");
  });

  test("SET_DESCRIPTION and SET_COPIED update transient fields", () => {
    let state = evidenceUploadReducer(baseState, {
      type: "SET_DESCRIPTION",
      description: "Updated description",
    });
    assert.strictEqual(state.description, "Updated description");

    state = evidenceUploadReducer(state, { type: "SET_COPIED", field: "cid" });
    assert.strictEqual(state.copiedField, "cid");
  });

  test("RESET returns state to initial clean state", () => {
    const modified = evidenceUploadReducer(baseState, {
      type: "SET_ERROR",
      error: "Some error",
    });
    const reset = evidenceUploadReducer(modified, { type: "RESET" });
    assert.deepStrictEqual(reset, initialEvidenceUploadState());
  });
});

describe("DisputeSlider addEvidence integration", () => {
  test("disputeReducer appends newly uploaded evidence via addEvidence action", () => {
    const initial = initialDisputeState();
    const initialEvidenceCount = initial.evidence.length;

    const newEvidence = {
      url: "https://ipfs.io/ipfs/QmNewDisputeEvidence1234567890",
      description: "Arbiter inspection report",
    };

    const updated = disputeReducer(initial, {
      type: "addEvidence",
      evidence: newEvidence,
    });

    assert.strictEqual(updated.evidence.length, initialEvidenceCount + 1);
    assert.deepStrictEqual(updated.evidence[updated.evidence.length - 1], newEvidence);
  });
});
