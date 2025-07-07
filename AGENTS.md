# geofront Agents.md Guide for LLM Agents

This **AGENT.md** file provides comprehensive guidance for large language model (LLM) agents working with the `geofront` codebase.

## Project Structure for LLM Agent Navigation

```
geofront/
├── Cargo.toml          # Rust crate manifest with dependencies
└── src/
    ├── lib.rs          # Core logic: FFI exports, listener/router, zero-copy forwarding, rate limiting, proxy support, metrics
    └── protocol.rs     # Minecraft protocol parsing & serialization: VarInt/String utilities, Disconnect packet
```

**Instructions for LLM Agents:**

- Focus on `/src/lib.rs` and `/src/protocol.rs` for code analysis and generation.
- Do not modify `Cargo.toml` unless updating dependencies or adding features.

## Coding Conventions for LLM Agents

### General Rust Conventions

- Follow existing `rustfmt` formatting and `clippy` lints.
- Use `snake_case` for functions and variables, `PascalCase` for types.
- Leverage type inference and pattern matching where appropriate.
- Keep functions small and single-responsibility; extract helpers for repeated logic.

### Async & Zero-Copy

- Use Tokio’s multi-threaded runtime for all async tasks.
- After login, use `tokio-splice2::copy_bidirectional` for zero-copy on Linux, and fallback to `tokio::io::copy`.
- Always `.await` on I/O or rate-limiter calls to yield to the runtime.

### FFI & Public API

- All `extern "C" fn` must use simple C types (`c_char`, `c_ushort`, `u64`).
- Memory allocated for C strings must be freed by `proxy_free_route` when no longer needed.
- New FFI functions require `#[no_mangle]` and `extern "C"` declarations.

### Error Handling & Logging

- Use `tracing` macros (`info!`, `error!`, `debug!`) at key events.
- On recoverable errors (e.g., parse failures), log and clean up connection, but do not panic.
- For FFI, return negative constants (`PROXY_ERR_*`) on failure.

## Testing Requirements for LLM Agents

- Rust unit tests should live in `src/` using `#[cfg(test)]`.
- Key test targets: `protocol.rs` VarInt/String parsing & `write_disconnect` packet format.
- Run tests with:

  ```bash
  cargo test
  ```

## Pull Request Guidelines for LLM Agents

When LLM Agents generate changes:

1. **Clarity**: Include a descriptive summary of changes.
2. **Scope**: Keep PRs focused on a single feature or fix.
3. **Testing**: Ensure new code has accompanying tests and all existing tests pass.
4. **Documentation**: Update `AGENT.md` or inline comments for any new public APIs.

## Programmatic Checks for LLM Agents

Before merging:

```bash
# Formatting check
cargo fmt -- --check

# Linting
cargo clippy -- -D warnings

# Build
cargo build --release
```

All checks must pass to maintain code quality and consistency.
