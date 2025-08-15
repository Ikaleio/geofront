# Geofront

High-performance Minecraft proxy core built with Rust and Bun FFI.

## Project Structure

This project is a hybrid Rust/TypeScript codebase:

- `src/` - Rust core library with FFI bindings
  - `lib.rs` - Main library entry point
  - `connection.rs` - Connection handling logic
  - `protocol.rs` - Minecraft protocol implementation
  - `ffi.rs` - FFI interface for JavaScript
  - `state.rs` - Global state management
  - `splice.rs` - Zero-copy forwarding (Linux)
  - `types.rs` - Type definitions
  - `logging.rs` - Logging configuration
  - `geofront.ts` - TypeScript API wrapper
  - `motd.ts` - MOTD (Message of the Day) handling

- `example/` - Usage examples
- `tests/` - Test suite
- `dist/` - Built artifacts

## Build & Commands

### Library Import Rules
The project has two distinct build modes that affect which binary is loaded:

**Development Mode:**
- `cargo build` - Builds development version binary to `target/debug/`
- `bun dev <xxx.ts>` - Uses development binary from `target/debug/`
- `bun dev:test [xxx.ts]` - Uses development binary for testing

**Production Mode:**
- `bun run build` (build.mjs) - Builds production version binary to `dist/`
- `bun run <xxx.ts>` - Uses production binary from `dist/`
- `bun test [xxx.ts]` - Uses production binary for testing

### Development
```bash
# Install dependencies
bun install

# Build Rust library for development
cargo build
# OR
bun run dev:build

# Run with development binary
bun dev example/simple.ts

# Test with development binary
bun dev:test
bun dev:test tests/simulated_proxy_test.ts
```

### Production
```bash
# Build production version (includes Rust compilation)
bun run build

# Run with production binary
bun run example/simple.ts

# Test with production binary  
bun test
bun test tests/simulated_proxy_test.ts
```

## Code Style

### Rust
- Follow standard Rust conventions
- Use `tracing` for logging, not `println!`
- Prefer async/await for I/O operations
- Use proper error handling with `Result<T, E>`
- Document public APIs with `///` comments

### TypeScript
- Use TypeScript strict mode
- Validate data with Zod schemas
- Prefer `const` over `let`
- Use descriptive variable names
- Follow camelCase for variables, PascalCase for types

### FFI Interface
- All FFI functions must handle null pointers safely
- Use proper memory management with `proxy_free_string`
- Convert between JavaScript and Rust types carefully
- Handle errors gracefully across language boundaries

## Architecture

### Core Design
- **Rust Core**: High-performance networking with Tokio
- **FFI Layer**: Safe communication between Rust and JavaScript
- **TypeScript API**: User-friendly interface with type safety
- **Event-driven**: Asynchronous request/response pattern

### Key Components
1. **Connection Manager**: Handles client connections and routing
2. **Protocol Handler**: Minecraft protocol parsing and manipulation  
3. **Rate Limiter**: Token bucket algorithm for bandwidth control
4. **Metrics System**: Real-time statistics collection
5. **Zero-copy Forwarding**: Linux splice() for optimal performance

### Data Flow
1. Client connects → Connection manager
2. Handshake parsing → Protocol handler
3. JavaScript router callback → Routing decision
4. Backend connection → Data forwarding
5. Metrics collection → Statistics update

## Testing

### Framework
- Uses Bun's built-in test runner
- Located in `tests/` directory
- Simulated proxy tests for various scenarios

### Running Tests
```bash
# Run all tests
bun run dev:test

# Run specific test
bun test tests/simulated_proxy_test.ts
```

### Test Categories
- **Protocol Tests**: Minecraft protocol handling
- **Proxy Tests**: End-to-end proxy functionality  
- **Metrics Tests**: Statistics collection accuracy
- **Stress Tests**: Performance and stability
- **SOCKS5 Tests**: Upstream proxy functionality

## Security

### Memory Safety
- Rust provides memory safety for the core
- FFI boundaries require careful pointer handling
- Always free allocated strings with `proxy_free_string`

### Network Security
- Validate all user inputs through Zod schemas
- Sanitize Minecraft protocol data
- Rate limiting prevents DoS attacks
- Support for proxy protocol headers

### Data Protection
- No sensitive data logging by default
- Configurable logging levels
- Secure handling of connection metadata

## Configuration

### Environment Variables
- `NODE_ENV=development` - Enables development mode
- Rust library loading path changes based on environment

### Options
Configure through `GeofrontOptions`:
- `proxyProtocolIn`: Handle proxy protocol headers ('none', 'optional', 'strict')

## Dependencies

### Rust
- `tokio` - Async runtime
- `tracing` - Structured logging
- `serde` - Serialization
- `governor` - Rate limiting
- `tokio-socks` - SOCKS5 proxy support

### TypeScript
- `zod` - Runtime type validation
- `bun:ffi` - Foreign function interface
- `mc-chat-format` - Minecraft text formatting

## Git Workflow

- Main branch: `dev`
- Use conventional commits
- Run tests before committing
- Build should pass on all commits

## Performance Considerations

- Zero-copy forwarding on Linux using splice()
- Minimize memory allocations in hot paths
- Use efficient data structures (HashMap, Vec)
- Async I/O throughout the stack
- Connection pooling where applicable

## Debugging

### Rust
- Use `RUST_LOG=debug` for detailed logging
- Enable debug symbols in development builds

### TypeScript  
- Development mode provides additional logging
- Use Bun's debugger for JavaScript issues

### FFI Issues
- Check pointer validity before dereferencing
- Verify string encoding (UTF-8)
- Monitor memory usage for leaks