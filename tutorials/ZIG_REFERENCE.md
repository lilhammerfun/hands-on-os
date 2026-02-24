# Zig 生态参考项目

> 按学习阶段整理的 Zig 项目参考列表。不是用来通读的——遇到具体设计问题时查阅，完成项目后回头对比自己的 trade-off。

---

## 使用原则

1. **带着问题读**：先自己实现，遇到设计卡点时去看别人怎么做的
2. **重心在 Linux 源码**：参考项目是辅助，Linux 源码和 xv6 才是主线参考
3. **完成后对比**：每个项目做完回头看——你的设计和参考项目有什么不同？谁的 trade-off 更好？

---

## 01_Shell 阶段

| 项目 | 说明 | 参考价值 |
|------|------|----------|
| [zigish](https://github.com/ratfactor/zigish) | Zig 写的 toy shell | 看别人怎么处理 fork/exec/pipe 的 Zig 封装 |
| [codecrafters-shell-zig](https://github.com/makyinmars/codecrafters-shell-zig) | POSIX shell 挑战解法 | 结构清晰，适合快速对比 |
| [Bun](https://github.com/oven-sh/bun) 进程管理部分 | 生产级 Zig 项目 | 看 posix spawn 的工业级封装方式 |

---

## 02_Gateway 阶段

| 项目 | 说明 | 参考价值 |
|------|------|----------|
| **[libxev](https://github.com/mitchellh/libxev)** | Mitchell Hashimoto 的跨平台事件循环 | **精读推荐**。同时抽象 epoll/kqueue/io_uring，代码质量极高。关键问题：统一的 `Completion` 结构如何抹平三种后端差异？牺牲了什么？ |
| [http.zig](https://github.com/karlseguin/http.zig) | Zig 生态最成熟的 HTTP server | 14 万 req/s，不依赖 std.http.Server。看 HTTP 解析和连接管理 |
| [async_io_uring](https://github.com/saltzm/async_io_uring) | io_uring + 协程事件循环 | 教学向，看 io_uring 的 SQ/CQ 怎么和协程配合 |
| [websocket.zig](https://github.com/karlseguin/websocket.zig) | WebSocket 实现 | 配合 http.zig 看协议升级和帧解析 |
| [zig-network](https://github.com/ikskuh/zig-network) | 跨平台 socket 抽象 | TCP/UDP 最小公共子集，看接口设计 |
| [zzz](https://github.com/zxhoper/zig-http-zzz) | 高性能网络服务框架 | 比 Zap 快 66%，内存只用 21%。看内存效率优化 |

---

## 03_FUSE FS 阶段

| 项目 | 说明 | 参考价值 |
|------|------|----------|
| **[TigerBeetle](https://github.com/tigerbeetle/tigerbeetle)** | Zig 写的金融交易数据库 | **精读推荐**。direct I/O + io_uring + WAL + 崩溃一致性 + Viewstamped Replication。关键问题：为什么绕过 page cache 用 direct I/O？WAL 的 fsync 策略怎么选？ |
| [zig-fuse](https://github.com/shanoaice/zig-fuse) | Zig 的 FUSE 绑定 | 直接操作 `/dev/fuse` 绕过 libfuse，看内核接口怎么用 Zig 封装 |
| [tls.zig](https://github.com/ianic/tls.zig) | TLS 1.3/1.2 实现 | 加密层参考，看密码学原语怎么组合 |

---

## 04_Zig OS 阶段

| 项目 | 说明 | 参考价值 |
|------|------|----------|
| **[Pluto](https://github.com/ZystemOS/pluto)** | 最成熟的 Zig OS 内核（x86） | **精读推荐**。有内存管理/中断/调度。关键问题：页帧分配器选了什么结构？和 xv6 的选择有什么不同？ |
| **[Ymir](https://hv.smallkirby.com/)** | Zig 写的 Type-1 Hypervisor 教程 | **精读推荐**。Intel VT-x，有完整博客系列。理解虚拟化比自己写一个更重要 |
| [daintree](https://github.com/kivikakk/daintree) | ARMv8-A/RISC-V 内核 + UEFI 引导 | 看多架构抽象怎么做 |
| [CascadeOS](https://github.com/CascadeOS/CascadeOS) | 通用桌面 OS 目标 | 架构设计参考，看模块划分 |
| [Zvisor](https://github.com/b0bleet/zvisor) | 基于 KVM 的轻量 Hypervisor | 看 KVM API 在 Zig 中的使用 |
| [Hello-UEFI-Zig](https://github.com/DanB91/Hello-UEFI-Zig) | UEFI 裸机启动模板 | 引导阶段的最小起点 |
| [TOPPERS/ASP3 in Zig](https://github.com/toppers/asp3_in_zig) | RTOS 的 Zig 重写 | 实时调度参考 |

---

## 通用 / 跨阶段

| 项目 | 说明 | 参考价值 |
|------|------|----------|
| [jdz_allocator](https://github.com/joadnacer/jdz_allocator) | 通用内存分配器 | 有 benchmark 对比 std GPA / c_allocator / rpmalloc。学内存分配器设计 |
| [zelf](https://github.com/kubkon/zelf) | ELF 解析工具（readelf 替代） | 理解链接器/加载器/ELF 格式 |
| [MicroZig](https://github.com/ZigEmbeddedGroup/microzig) | 嵌入式 HAL 框架 | 看硬件抽象层怎么设计 |
| [Zig 编译器 ELF linker](https://github.com/ziglang/zig/blob/master/src/link/Elf.zig) | Zig 自带的 ELF 链接器 | 生产级实现，理解 symbol resolution / relocation |
| [Mach Engine](https://github.com/hexops/mach) | Zig 游戏引擎 | 看跨平台 GPU 抽象和零依赖构建 |

---

## 标杆项目（值得反复回看）

这两个项目代表了 Zig 生态的最高工程水准：

### TigerBeetle
- 零依赖、zero-copy、direct I/O、io_uring
- 分布式共识（Viewstamped Replication）
- 金融级崩溃一致性
- 值得在 FUSE FS 阶段和 Gateway 阶段反复参考

### Bun
- 生产级运行时的内存管理、网络 I/O、进程管理
- Zig + C/C++ 互操作的工业实践
- 值得在理解性能优化时参考

---

## 来源

- [awesome-zig (zigcc)](https://github.com/zigcc/awesome-zig)
- [awesome-zig (nrdmn)](https://github.com/nrdmn/awesome-zig)
- GitHub 搜索 + 项目交叉引用
