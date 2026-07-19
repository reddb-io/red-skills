# Good and Bad Tests

## Good Tests

**Integration-style**: Test through real interfaces, not mocks of internal parts.

```typescript
// GOOD: Tests observable behavior
test("user can checkout with valid cart", async () => {
  const cart = createCart();
  cart.add(product);
  const result = await checkout(cart, paymentMethod);
  expect(result.status).toBe("confirmed");
});
```

Characteristics:

- Tests behavior users/callers care about
- Uses public API only
- Survives internal refactors
- Describes WHAT, not HOW
- One logical assertion per test

## Bad Tests

**Implementation-detail tests**: Coupled to internal structure.

```typescript
// BAD: Tests implementation details
test("checkout calls paymentService.process", async () => {
  const mockPayment = jest.mock(paymentService);
  await checkout(cart, payment);
  expect(mockPayment.process).toHaveBeenCalledWith(cart.total);
});
```

Red flags:

- Mocking internal collaborators
- Testing private methods
- Asserting on call counts/order
- Test breaks when refactoring without behavior change
- Test name describes HOW not WHAT
- Verifying through external means instead of interface

```typescript
// BAD: Bypasses interface to verify
test("createUser saves to database", async () => {
  await createUser({ name: "Alice" });
  const row = await db.query("SELECT * FROM users WHERE name = ?", ["Alice"]);
  expect(row).toBeDefined();
});

// GOOD: Verifies through interface
test("createUser makes user retrievable", async () => {
  const user = await createUser({ name: "Alice" });
  const retrieved = await getUser(user.id);
  expect(retrieved.name).toBe("Alice");
});
```

## Tautological Tests

**Tautological assertion**: expected value recomputed the way the code computes it — passes by construction and proves nothing.

```typescript
// BAD: tautological — assertion mirrors the implementation
test("add returns the sum", () => {
  const a = 3;
  const b = 4;
  expect(add(a, b)).toBe(a + b); // always true regardless of what add does
});

// GOOD: expected value from an independent source of truth
test("add returns the sum", () => {
  expect(add(3, 4)).toBe(7); // 7 is a literal from a worked example
});
```

Red flags:

- Expected value is computed using the same operator/function as the implementation
- Swapping the implementation for any expression that satisfies the same type would still pass
- The test can never catch an off-by-one or wrong-operator bug
