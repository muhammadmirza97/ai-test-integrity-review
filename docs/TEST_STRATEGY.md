# Test Strategy and Acceptance Criteria

## Quality principle

This product sells trust.

Tests must prioritize:

1. no false PASS;
2. very low false BLOCK;
3. deterministic reproducibility;
4. safe behavior on malicious input;
5. clear error states.

## Required layers

1. unit tests
2. AST rule fixtures
3. Git integration tests
4. test-runner adapter tests
5. red/green repository fixtures
6. mutation integration tests
7. CLI end-to-end tests
8. GitHub Action end-to-end tests
9. clean real-PR validation corpus

## Rule fixture requirements

Each BLOCK rule requires:

- positive fixture
- negative fixture
- ambiguous fixture where applicable

Example `MI004`:

Must BLOCK:

```ts
expect(response.status).toBe(401);
```

becomes:

```ts
expect(response.status).toBeDefined();
```

Must not BLOCK:

```ts
expect(response.status).toBe(401);
```

becomes an equally specific semantic assertion.

If equivalence is uncertain, WARN is acceptable; BLOCK is not.

## Red/green required cases

1. real bug fix + regression test: base fails, head passes
2. fake test: base passes, head passes -> `MI006` (advisory WARN by default; BLOCK when the base policy says so)
3. base lacks newly imported API -> `MI103` WARN, not verified RED
4. base tests already broken -> inconclusive
5. head test fails -> ERROR/BLOCK, never PASS
6. timeout -> ERROR
7. Jest
8. Vitest

## Mutation required cases

1. strong test kills changed-condition mutant
2. weak test allows mutant -> WARN
3. max-mutant budget enforced
4. timeout enforced
5. Stryker startup/config failure never produces PASS
6. Jest adapter
7. Vitest adapter

## Security tests

- shell metacharacters in filename do not execute
- shell metacharacters in test name do not execute
- path traversal rejected
- unsafe symlink rejected or safely handled
- base config remains authoritative
- worktree cleaned after success
- worktree cleaned after exception
- worktree cleaned after timeout
- core check performs no network calls
- no environment values intentionally logged
- prompt-injection strings remain inert data

## Performance engineering targets

Not marketing claims:

- deterministic analysis: <10s on normal small/medium PR
- red/green default budget: <2 minutes
- mutation default budget: 3 minutes
- total target after dependencies installed: normally <5 minutes

Measure and report stage timings.

## MVP definition of done

- all BLOCK rules have positive and negative tests
- Jest and Vitest fixtures pass
- red/green behavior matches specification
- targeted mutation works
- GitHub Action runs on a real PR
- BLOCK creates a failed check
- PASS creates a successful check
- ERROR cannot become PASS
- no source upload
- no secret required
- clean install docs tested
- known limitations documented
