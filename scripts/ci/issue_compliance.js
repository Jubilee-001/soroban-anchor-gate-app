/**
 * Issue Compliance and Architectural Scope Verification Module
 * Validates PR against linked issues, author assignment, issue capacity (max 4),
 * and architectural layer scope integrity.
 */
module.exports = async ({ github, context, core }) => {
  const pr = context.payload.pull_request;
  const prAuthor = pr.user.login;
  const prBody = pr.body || '';
  const prTitle = pr.title || '';
  const branchName = pr.head.ref || '';

  console.log(`Checking PR #${pr.number} by @${prAuthor} (branch: ${branchName})`);

  // Maintainer / Release / Dependabot Bypass
  const isMaintainer = prAuthor.toLowerCase() === context.repo.owner.toLowerCase() || prAuthor.toLowerCase() === 'emarkees';
  const isDependabot = prAuthor.toLowerCase() === 'dependabot[bot]' || prAuthor.toLowerCase() === 'dependabot';
  const isReleasePR = branchName === 'develop' && pr.base.ref === 'main';

  if (isMaintainer || isReleasePR || isDependabot) {
    const roleName = isDependabot ? 'Dependabot' : (isReleasePR ? 'Release Sync' : 'Maintainer');
    console.log(`${roleName} PR verified for @${prAuthor}.`);
    core.setOutput('is_compliant', 'true');
    core.setOutput('linked_issue', isDependabot ? 'automated-deps' : (isReleasePR ? 'release-sync' : 'maintainer-branch'));
    core.setOutput('issue_title', isDependabot ? 'Dependabot Dependency Update' : (isReleasePR ? 'Release Sync: develop -> main' : 'Maintainer Direct Update'));
    core.setOutput('issue_layer', 'all');
    core.setOutput('scope_report', `${roleName} PR: verified automated/trusted scope.`);
    core.setOutput('failure_reason', '');
    return;
  }

  // Step 1: Extract all issue references (supports single, comma, 'and' separated, max 4)
  const issueNumbers = new Set();

  // Pattern A: Comma or 'and' separated lists e.g. "Closes #120, #121 and #122" or "Fixes #1, Fixes #2"
  const multiIssueRegex = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?[ \t]*(#[0-9]+(?:[ \t]*(?:,|and|&)[ \t]*#[0-9]+)*)/gi;
  let match;
  while ((match = multiIssueRegex.exec(prBody)) !== null) {
    const nums = match[1].match(/\d+/g);
    if (nums) nums.forEach(n => issueNumbers.add(parseInt(n, 10)));
  }
  while ((match = multiIssueRegex.exec(prTitle)) !== null) {
    const nums = match[1].match(/\d+/g);
    if (nums) nums.forEach(n => issueNumbers.add(parseInt(n, 10)));
  }

  // Pattern B: Standard individual keywords: "Closes #123", "Fixes: #123"
  const singleRegex = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)/gi;
  while ((match = singleRegex.exec(prBody)) !== null) {
    issueNumbers.add(parseInt(match[1], 10));
  }
  while ((match = singleRegex.exec(prTitle)) !== null) {
    issueNumbers.add(parseInt(match[1], 10));
  }

  // Pattern C: Full issue URLs: "Closes https://github.com/Sorobo-Gate/soroban-anchor-gate-app/issues/123"
  const urlRegex = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*https?:\/\/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/gi;
  while ((match = urlRegex.exec(prBody)) !== null) {
    issueNumbers.add(parseInt(match[1], 10));
  }

  // Pattern D: "Linked Issue: #42" or "Linked Issues: #42, #43"
  const linkedRegex = /Linked\s+Issue[s]?\s*:\s*(?:(?:Closes|Fixes|Resolves)[ \t]*)?(#[0-9]+(?:[ \t]*(?:,|and|&)[ \t]*#[0-9]+)*)/gi;
  while ((match = linkedRegex.exec(prBody)) !== null) {
    const nums = match[1].match(/\d+/g);
    if (nums) nums.forEach(n => issueNumbers.add(parseInt(n, 10)));
  }

  // Pattern E: Branch names fallback (ONLY if no explicit issues were declared in PR body or title)
  // Prevents draft/template branch numbers (e.g. wave/56-...) from overriding or colliding with real issues (e.g. #98)
  if (issueNumbers.size === 0) {
    const branchWave = branchName.match(/^wave\/(\d+)/);
    if (branchWave) {
      issueNumbers.add(parseInt(branchWave[1], 10));
    } else {
      const branchFeat = branchName.match(/(?:issue|wave)s?[-/](\d+)(?:[-_](\d+))?/i);
      if (branchFeat) {
        if (branchFeat[1]) issueNumbers.add(parseInt(branchFeat[1], 10));
        if (branchFeat[2]) issueNumbers.add(parseInt(branchFeat[2], 10));
      }
    }
  }

  // Validation: Check if at least 1 issue was linked
  if (issueNumbers.size === 0) {
    core.setOutput('is_compliant', 'false');
    core.setOutput('linked_issue', '');
    core.setOutput('failure_reason',
      '❌ **No linked issue found.**\n' +
      '- **Action required:** Your PR description must reference an approved GitHub issue (e.g. `Closes #42` or `Closes #10, #11`).\n' +
      `- **Where to find issues:** Browse open sprint tasks at https://github.com/${context.repo.owner}/${context.repo.repo}/issues?q=is%3Aissue+is%3Aopen+label%3Adrips-wave\n` +
      '- **Branch naming:** Recommended branch format is `wave/<issue-number>-<short-description>`.');
    return;
  }

  // Validation: Enforce max 4 issues per PR to preserve security integrity & review depth
  if (issueNumbers.size > 4) {
    const foundList = Array.from(issueNumbers).map(n => `#${n}`).join(', ');
    const firstFour = Array.from(issueNumbers).slice(0, 4).map(n => `#${n}`).join(', ');
    core.setOutput('is_compliant', 'false');
    core.setOutput('linked_issue', foundList);
    core.setOutput('failure_reason',
      `❌ **Issue Capacity Exceeded (${issueNumbers.size} issues found: ${foundList}):**\n` +
      `- Contributors may close a **maximum of 4 issues per PR** to maintain review quality and system integrity.\n` +
      `- **Action required:** Edit your PR description to only include up to 4 issues (e.g. keep ${firstFour}), and open a new pull request for the remaining issue(s).`);
    return;
  }

  // Step 2: Validate Issue Assignment & Status for EVERY claimed issue
  const validIssues = [];
  const verifiedIssueDetails = [];
  const errors = [];
  const allowedLayers = new Set();

  const layerInfo = {
    contracts: { name: 'Smart Contracts', dir: 'contracts/' },
    web: { name: 'Frontend Web App', dir: 'apps/web/' },
    sdk: { name: 'Contract Client SDK', dir: 'packages/contract-client/' },
    relay: { name: 'Go Relay Daemon', dir: 'services/relay/' },
    docs: { name: 'Documentation & Evidence', dir: 'docs/, evidence/' }
  };

  for (const issueNum of issueNumbers) {
    try {
      const res = await github.rest.issues.get({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: issueNum,
      });
      const iss = res.data;

      if (iss.pull_request) {
        errors.push(`#${issueNum} is a pull request, not an issue.`);
        continue;
      }

      if (iss.state !== 'open') {
        errors.push(`#${issueNum} is closed. Work cannot be submitted for already closed issues.`);
        continue;
      }

      const assignees = (iss.assignees || []).map(a => a.login.toLowerCase());
      if (!assignees.includes(prAuthor.toLowerCase())) {
        errors.push(
          `#${issueNum} is not assigned to @${prAuthor}. ` +
          `Assigned to: ${assignees.length ? assignees.map(a => '@' + a).join(', ') : 'none'}.`
        );
        continue;
      }

      validIssues.push(issueNum);
      verifiedIssueDetails.push(iss);

      const issueBody = iss.body || '';
      const issueTitle = iss.title || '';
      const issueLabels = (iss.labels || []).map(l => (typeof l === 'string' ? l : l.name || '').toLowerCase());
      const allText = `${issueTitle} ${issueBody} ${issueLabels.join(' ')}`.toLowerCase();

      let layerDetected = false;
      if (allText.includes('contracts') || allText.includes('contract') || allText.includes('soroban')) {
        allowedLayers.add('contracts');
        layerDetected = true;
      }
      if (allText.includes('web') || allText.includes('frontend') || allText.includes('ui') || allText.includes('dashboard')) {
        allowedLayers.add('web');
        layerDetected = true;
      }
      if (allText.includes('sdk') || allText.includes('client')) {
        allowedLayers.add('sdk');
        layerDetected = true;
      }
      if (allText.includes('relay') || allText.includes('daemon')) {
        allowedLayers.add('relay');
        layerDetected = true;
      }
      if (allText.includes('doc') || allText.includes('evidence') || allText.includes('playbook')) {
        allowedLayers.add('docs');
        layerDetected = true;
      }

      if (!layerDetected) {
        allowedLayers.add('all');
      }
    } catch (err) {
      errors.push(`Issue #${issueNum} query failed: ${err.message}`);
    }
  }

  // If ANY linked issue failed assignment or is closed, fail compliance
  if (errors.length > 0 || validIssues.length !== issueNumbers.size) {
    const listStr = Array.from(issueNumbers).map(n => `#${n}`).join(', ');
    core.setOutput('is_compliant', 'false');
    core.setOutput('linked_issue', listStr);
    core.setOutput('failure_reason',
      `❌ **Issue verification failed for [${listStr}]:**\n` +
      errors.map(e => `- ${e}`).join('\n') +
      '\n\n- **Action required:**\n' +
      '  - Ensure each issue is open and not already resolved.\n' +
      '  - Comment on the issue to request official assignment from maintainer @emarkees before submitting a PR.\n' +
      '  - If you intended to work on another issue, update your PR description with the correct issue number.');
    return;
  }

  // Step 3: Branch naming check (informational notice)
  const branchRegex = /^(?:wave\/\d+-[\w-]+|feat\/[\w-]+)$/i;
  let branchNotice = '';
  if (!branchRegex.test(branchName)) {
    branchNotice = `\n⚠️ **Branch naming notice:** Branch \`${branchName}\` does not follow recommended \`wave/<issue>-<description>\` pattern.`;
  }

  // Step 4: Check PR Changed Files against combined architectural scope
  const prFiles = await github.paginate(github.rest.pulls.listFiles, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: pr.number,
    per_page: 100,
  });

  const changedPaths = prFiles.map(f => f.filename);
  const forbiddenFiles = [];
  const outOfScopeFiles = [];

  for (const path of changedPaths) {
    // STRICT RULE: Contributors must NEVER modify CI workflows, security gate files, or CODEOWNERS
    if (path.startsWith('.github/') || path.startsWith('scripts/ci/')) {
      forbiddenFiles.push(path);
      continue;
    }

    if (allowedLayers.has('all')) {
      continue;
    }

    let inScope = false;
    // evidence/ and markdown documentation are always permitted across any layer
    if (path.startsWith('evidence/') || path.endsWith('.md')) {
      inScope = true;
    } else if (allowedLayers.has('contracts') && path.startsWith('contracts/')) {
      inScope = true;
    } else if (allowedLayers.has('web') && path.startsWith('apps/web/')) {
      inScope = true;
    } else if (allowedLayers.has('sdk') && path.startsWith('packages/contract-client/')) {
      inScope = true;
    } else if (allowedLayers.has('relay') && path.startsWith('services/relay/')) {
      inScope = true;
    } else if (allowedLayers.has('docs') && path.startsWith('docs/')) {
      inScope = true;
    }

    if (!inScope) {
      outOfScopeFiles.push(path);
    }
  }

  if (forbiddenFiles.length > 0) {
    core.setOutput('is_compliant', 'false');
    core.setOutput('linked_issue', validIssues.map(n => `#${n}`).join(', '));
    core.setOutput('failure_reason',
      `🚨 **Unauthorized Infrastructure Changes:**\n` +
      `Your PR modifies CI workflows or security scripts which are strictly reserved for maintainers:\n` +
      forbiddenFiles.map(f => `- \`${f}\``).join('\n') +
      '\n\n- **Action required:** Revert these files to the base branch using:\n' +
      '  `git checkout origin/develop -- ' + forbiddenFiles.join(' ') + '`\n' +
      '  `git commit -m "revert unauthorized workflow/CI changes"`\n' +
      '  `git push`');
    return;
  }

  // Strict Scope Check: If files are modified outside assigned layer, block merge and advise contributor
  if (outOfScopeFiles.length > 0) {
    const allowedDisplay = Array.from(allowedLayers)
      .map(l => layerInfo[l] ? `\`${layerInfo[l].dir}\` (${layerInfo[l].name})` : `\`${l}\``)
      .join(' or ');

    const fileList = outOfScopeFiles.slice(0, 15).map(f => `- \`${f}\``).join('\n');
    const moreNotice = outOfScopeFiles.length > 15 ? `\n...and ${outOfScopeFiles.length - 15} more file(s)` : '';
    const quoteList = outOfScopeFiles.slice(0, 10).map(f => `"${f}"`).join(' ');

    let failureMsg = `⚠️ **Scope Violation: Files Modified Outside Assigned Architectural Layer**\n\n`;
    failureMsg += `Your linked issue(s) (${validIssues.map(n => '#' + n).join(', ')}) authorize changes only within:\n`;
    failureMsg += `> 🎯 **Where to work (Allowed):** ${allowedDisplay} (plus \`evidence/\` for test proofs and \`.md\` docs)\n\n`;
    failureMsg += `### 🚫 What to delete or revert (${outOfScopeFiles.length} out-of-scope file${outOfScopeFiles.length > 1 ? 's' : ''}):\n`;
    failureMsg += `${fileList}${moreNotice}\n\n`;
    failureMsg += `### 🛠️ How to Resolve (Keep your PR open and run these in terminal):\n\n`;
    failureMsg += `\`\`\`bash\n`;
    failureMsg += `# 1. Revert out-of-scope files back to develop:\n`;
    failureMsg += `git checkout origin/develop -- ${quoteList}\n\n`;
    failureMsg += `# (If you added new files that don't belong, delete them with: git rm -f <path>)\n\n`;
    failureMsg += `# 2. Commit your cleanup:\n`;
    failureMsg += `git commit -m "refactor: remove out-of-scope files to match assigned issue"\n\n`;
    failureMsg += `# 3. Push to your PR branch:\n`;
    failureMsg += `git push\n`;
    failureMsg += `\`\`\`\n\n`;
    failureMsg += `> 💡 **Notice:** Your PR remains **OPEN**. Once you push this cleanup, the security compliance check will re-run automatically!`;

    core.setOutput('is_compliant', 'false');
    core.setOutput('linked_issue', validIssues.map(n => `#${n}`).join(', '));
    core.setOutput('failure_reason', failureMsg);
    return;
  }

  const layerList = Array.from(allowedLayers).join(', ');
  const scopeReport = `Verified **${validIssues.length}** issue(s): ${validIssues.map(n => '#' + n).join(', ')}.\n` +
    `- **Authorized Architecture Layer(s):** \`${layerList}\`\n` +
    `- **Total Changed Files:** ${changedPaths.length}`;

  core.setOutput('is_compliant', 'true');
  core.setOutput('linked_issue', validIssues.map(n => `#${n}`).join(', '));
  core.setOutput('issue_title', verifiedIssueDetails.map(iss => `#${iss.number}: ${iss.title}`).join(' | '));
  core.setOutput('issue_layer', layerList);
  core.setOutput('scope_report', scopeReport);
  core.setOutput('failure_reason', branchNotice);
};
