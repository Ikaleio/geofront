这个代理项目（`geofront`）的总体架构和功能可分为以下几个部分：

1. **核心目标**

   - 提供一个高性能、可靠的 Minecraft“入口代理”（类似 nginx），能让玩家用同一 IP/端口根据不同 `host` 路由到不同后端服务器。
   - 支持完整的 Minecraft 握手与登录协议，拒绝连接时可发送自定义的 Disconnect 包。

2. **目录结构**

   ```
   geofront/
   ├── Cargo.toml
   └── src/
       ├── lib.rs       // 主逻辑：监听、路由、限速、零拷贝转发、上游代理、FFI 接口、Metrics
       └── protocol.rs  // 协议解析与封包：VarInt/String 读写、Disconnect 包构造
   ```

3. **主要模块**

   - **`protocol.rs`**

     - **`read_varint`/`write_varint`**：处理 Minecraft 协议中常用的可变整型。
     - **`read_string`/`write_string`**：长度前缀 UTF-8 字符串的读写。
     - **`write_disconnect`**：在登录阶段发送标准的 Disconnect 包并优雅关闭连接。

   - **`lib.rs`**

     1. **日志系统**：基于 `tracing`，支持程序启动时和运行时动态调整级别（`proxy_init_logging`/`proxy_set_log_level`）。
     2. **监听与路由**：

        - `proxy_start_listener`：在指定地址启动 Tokio TCP 监听。
        - 注册路由回调 `proxy_register_router`，回调可返回三种结果：

          - 正常路由到 `host:port`（并可指定上游 SOCKS5 代理）。
          - 拒绝连接（`host==NULL`），并携带自定义断线消息。

     3. **零拷贝转发**（Linux）

        - 通过 `tokio-splice2::copy_bidirectional`，在内核空间直接搬运流量，最大化性能。
        - 其他系统上退回到 `tokio::io::copy`。

     4. **带 burst 的限速**

        - 使用 `governor` 库实现令牌桶，可配置稳定速率与突发容量，动态通过 `proxy_set_rate_limit` 更新。

     5. **上游代理支持**

        - 回调返回的 `proxy` 字段支持以 `socks5://...` 为前缀，自动通过 SOCKS5 中转。

     6. **连接与统计管理**

        - 全局管理所有活跃连接的 Tokio 任务句柄，可通过 `proxy_disconnect` 强制中断。
        - 全局和单连接字节流量统计（`proxy_get_*` 和 `proxy_conn_get_*` 系列接口）。

     7. **清理与关闭**

        - `proxy_shutdown` 一键终止所有监听与连接。

4. **FFI 对接**

   - 对接 Bun/TS 使用 C ABI 导出函数，能在上层 JS/TS 里按需调用：

     - `proxy_start_listener`、`proxy_register_router`、`proxy_disconnect`
     - 日志配置、限速设置、Metrics 查询等。

5. **跨平台 & 可扩展性**

   - 针对 Linux 自动启用零拷贝；其他系统自动回退。
   - 路由回调可灵活扩展，实现自定义鉴权、限流或监控逻辑。
   - 轻量级、无外部依赖的核心，只需在上层提供配置与业务逻辑接口。

---

通过上述设计，整个代理服务在高并发、高带宽场景下能够保持低延迟、低 CPU 消耗，同时提供灵活的路由和监控能力。
