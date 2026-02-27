# 前言

这本书的路线是：用 Zig 写 4 个真实项目——Shell、Dev Gateway、Crash-consistent FUSE FS、Zig OS。每个项目都是可用的系统，操作系统概念在做的过程中学，不做中间练习。

为什么是 Zig？因为它和 C 一样能直接调用系统调用、操作裸指针、控制内存布局，但编译器帮你挡住了 C 最容易犯的错——悬垂指针、缓冲区溢出、未初始化内存。写系统程序需要贴近硬件，也需要安全网。Zig 两样都给。

## 四个项目

**Shell**（贯穿全程）：用户态 POSIX shell，从最基础的 fork/exec/wait 开始，逐步加入管道、信号处理、job control、namespace 隔离，最终移植进自己写的 OS。这是贯穿整本书的项目——每学一个新概念，就在 shell 里用上它。

**Dev Gateway**（性能向）：高性能本地开发网关。事件循环、HTTP 解析、内存管理在此项目中按需构建。涉及 epoll/io_uring、非阻塞 I/O、TCP 状态机、零拷贝、IPC 等概念。

**Crash-consistent FUSE FS**（正确性向）：透明加密文件系统，重点在崩溃一致性和 VFS 语义。涉及 inode/dentry/superblock、page cache、fsync 语义、日志等概念。这个项目会让读者深刻理解"正确性"在系统编程中意味着什么。

**Zig OS**（裸机整合）：把前三个项目学到的 OS 概念迁移到裸机，在 QEMU 上跑起自己的 shell。涉及引导、页表、中断、上下文切换、系统调用、设备驱动等概念。

## 学习原则

- **先可用，再正确，再快**：每个项目先有可运行版本和回归测试，最后才谈优化
- **对照 Linux 源码**：每个主题都要能指出 Linux 对应入口，理解"为什么这么设计"
- **定义清晰的 Done**：不写"学会/理解"，只写可验收的指标
- **只参考源码和文档**：不依赖书籍视频

## 参考资料

| 项目 | 用途 |
|------|------|
| [Linux kernel](https://elixir.bootlin.com) | 生产级实现参考 |
| [xv6](https://github.com/mit-pdos/xv6-public) | 教学 OS |
| [musl libc](https://musl.libc.org) | 易读的 libc |
| [dash](https://git.kernel.org) | 轻量 shell |
| [Redis](https://github.com/redis/redis) | 事件循环、网络 |

| 资源 | 内容 |
|------|------|
| man pages | 系统调用和库函数 |
| OSDev Wiki | OS 开发百科 |
| Intel SDM | x86 架构手册 |
| Zig 文档 | 语言和标准库 |
