# OS / Linux Kernel 完整知识图谱

> 本文是整个学习项目的**知识索引**。每个主题标注了覆盖它的项目阶段，学完后打 `[x]`。
> 如果某个关键概念被遗漏，对照此图谱即可发现。

## 图谱使用说明

- **项目映射**：每个知识点后标注最相关的项目阶段
  - `S` = Shell（01_shell）
  - `G` = Dev Gateway（02_gateway）
  - `F` = FUSE FS（03_fuse_fs）
  - `O` = Zig OS（04_zig_os）
  - `*` = 贯穿所有项目
- **进度标记**：`[ ]` 未学 → `[x]` 已学
- **来源缩写**：`[OSC]` = Operating System Concepts, `[OSTEP]` = Three Easy Pieces, `[LK]` = Linux Kernel

---

## 1. 基础与概览 (Foundations)

- [ ] 1.1 操作系统定义：资源管理器 vs 抽象层 `O`
- [ ] 1.2 计算机体系结构 `O`
  - [ ] 单处理器 / 多处理器(SMP) / NUMA
  - [ ] 存储层次（寄存器 → 缓存 → RAM → SSD → HDD）
  - [ ] 总线架构（系统总线、I/O 总线、PCIe）
- [ ] 1.3 中断驱动 I/O 与 DMA(Direct Memory Access) `O`
- [ ] 1.4 双模式运行（用户态 / 内核态）与特权级 `O` `S`
- [ ] 1.5 系统调用机制 `S` `*`
  - [ ] 系统调用表、`syscall` 指令（x86-64）/ `svc`（ARM）
  - [ ] 进入/退出路径
  - [ ] vDSO(virtual Dynamic Shared Object)
  - [ ] ABI(Application Binary Interface)
- [ ] 1.6 OS 内核结构 `O`
  - [ ] 宏内核(Monolithic Kernel)
  - [ ] 微内核(Microkernel)：Mach, L4, MINIX, seL4
  - [ ] 混合内核(Hybrid)：macOS, Windows NT
  - [ ] 外核(Exokernel)
  - [ ] 可加载内核模块(LKM, Loadable Kernel Module)
- [ ] 1.7 设计原则 `*`
  - [ ] 机制(Mechanism) vs 策略(Policy)
  - [ ] 最小权限原则(Principle of Least Privilege)
- [ ] 1.8 OS 历史：批处理 → 多道程序 → 分时 → UNIX → Linux `O`

---

## 2. 进程管理 (Process Management)

### 2.1 进程基础
- [x] 进程 vs 程序、进程状态模型 `S`
- [x] PCB(Process Control Block) / Linux `task_struct` `S`
- [x] 进程内存布局（text, data, heap, stack）`S`
- [x] `fork()` / `exec()` / `wait()` 生命周期 `S`
- [ ] `clone()` 系统调用与标志位 `S` `O`
- [x] 僵尸进程(Zombie) 与孤儿进程(Orphan) `S`
- [ ] 进程组(Process Group) 与会话(Session) `S`

### 2.2 CPU 调度 (CPU Scheduling)
- [ ] 调度队列：就绪队列、等待队列 `O`
- [ ] 上下文切换(Context Switch)：机制与开销 `O` `S`
- [ ] 调度算法 `O`
  - [ ] FCFS(First-Come, First-Served)
  - [ ] SJF(Shortest Job First) / SRTF
  - [ ] Round Robin 与时间片选择
  - [ ] 优先级调度（静态 / 动态）
  - [ ] 多级队列(Multilevel Queue)
  - [ ] 多级反馈队列(MLFQ, Multi-Level Feedback Queue)
  - [ ] 彩票调度(Lottery Scheduling) / 步幅调度(Stride)
  - [ ] 比例份额调度(Proportional Share)
- [ ] Linux CFS(Completely Fair Scheduler) `O`
  - [ ] 虚拟运行时间(vruntime)
  - [ ] 红黑树(Red-Black Tree) 时间线
  - [ ] CFS 带宽控制 / 组调度
- [ ] EEVDF 调度器（Linux 6.6+）`O`
- [ ] 多处理器调度 `O`
  - [ ] 处理器亲和性(Affinity)：软亲和 / 硬亲和
  - [ ] 负载均衡：推/拉迁移
  - [ ] NUMA 感知调度

### 2.3 实时调度 (Real-Time Scheduling)
- [ ] 硬实时 vs 软实时 `O`
- [ ] 速率单调调度(Rate-Monotonic, RMS)
- [ ] 最早截止期优先(EDF, Earliest Deadline First)
- [ ] POSIX 实时调度类：`SCHED_FIFO`, `SCHED_RR`, `SCHED_DEADLINE`
- [ ] 优先级反转(Priority Inversion) 与优先级继承(Priority Inheritance)
- [ ] Linux PREEMPT_RT 补丁

---

## 3. 线程与并发 (Threads & Concurrency)

### 3.1 线程基础
- [ ] 线程 vs 进程 `S` `G`
- [ ] 用户级线程 vs 内核级线程 `G`
- [ ] 线程模型：多对一、一对一、多对多 `G`
- [ ] POSIX Pthreads / Linux NPTL `G`
- [ ] 线程本地存储(TLS, Thread-Local Storage) `G`

### 3.2 多核编程
- [ ] Amdahl 定律 `G`
- [ ] 数据并行 vs 任务并行 `G`
- [ ] 缓存一致性(Cache Coherence) 与伪共享(False Sharing) `G` `O`

### 3.3 隐式线程
- [ ] 线程池(Thread Pool) `G`
- [ ] Fork-Join 并行
- [ ] 工作窃取(Work Stealing)
- [ ] 绿色线程 / 协程(Coroutine) / Fiber

---

## 4. 同步 (Synchronization)

### 4.1 基础问题
- [ ] 竞态条件(Race Condition) `S` `G`
- [ ] 临界区问题(Critical Section Problem) `G`
- [ ] 三个要求：互斥(Mutual Exclusion)、进展(Progress)、有限等待(Bounded Waiting)

### 4.2 硬件支持
- [ ] 内存屏障(Memory Barrier / Fence) `G` `O`
- [ ] Test-and-Set 指令
- [ ] Compare-and-Swap(CAS) / Compare-and-Exchange
- [ ] 原子变量与原子操作(Atomic Operations) `G`
- [ ] Load-Linked / Store-Conditional (LL/SC)

### 4.3 同步原语
- [ ] 自旋锁(Spinlock) `G` `O`
- [ ] 互斥锁(Mutex)：睡眠锁 vs 自适应锁 `G`
- [ ] 读写锁(Reader-Writer Lock) `G` `F`
- [ ] 信号量(Semaphore)：计数 / 二值 `G`
- [ ] 监视器(Monitor) 与条件变量(Condition Variable) `G`
- [ ] Futex(Fast Userspace Mutex) `G`

### 4.4 经典同步问题
- [ ] 生产者-消费者(Producer-Consumer / Bounded Buffer) `G`
- [ ] 读者-写者(Readers-Writers) `G` `F`
- [ ] 哲学家就餐(Dining Philosophers)

### 4.5 Linux 内核同步机制
- [ ] 内核自旋锁：`spin_lock`, `spin_lock_irqsave` `O`
- [ ] 内核互斥量：`struct mutex` `O`
- [ ] 顺序锁(Seqlock) `O`
- [ ] RCU(Read-Copy-Update) `O`
  - [ ] 宽限期(Grace Period)
  - [ ] 静止状态(Quiescent State)
  - [ ] Tree RCU / SRCU
- [ ] 完成变量(Completion Variable) `O`
- [ ] Per-CPU 变量 `O`
- [ ] Lockdep（锁依赖验证器）`O`

### 4.6 并发 Bug 类型
- [ ] 原子性违规(Atomicity Violation)
- [ ] 顺序违规(Order Violation)
- [ ] 死锁 Bug / 数据竞争(Data Race)

### 4.7 事件驱动并发 (Event-based Concurrency)
- [ ] `select()` / `poll()` `G`
- [ ] `epoll()`：边缘触发(ET) vs 水平触发(LT) `G`
- [ ] 事件循环(Event Loop) 模型 `G`
- [ ] `io_uring` `G`
  - [ ] 提交队列(SQ) / 完成队列(CQ)
  - [ ] Ring Buffer 架构
  - [ ] SQPOLL / 注册缓冲区

---

## 5. 死锁 (Deadlocks)

- [ ] 四个必要条件：互斥、持有并等待、非抢占、循环等待 `G`
- [ ] 资源分配图(Resource-Allocation Graph)
- [ ] 死锁预防：破坏四个条件之一
- [ ] 死锁避免：银行家算法(Banker's Algorithm) / 安全状态
- [ ] 死锁检测：等待图(Wait-for Graph)
- [ ] 死锁恢复：终止进程 / 资源抢占
- [ ] 活锁(Livelock) `G`

---

## 6. 内存管理 (Memory Management)

### 6.1 基础
- [ ] 地址绑定：编译时 / 加载时 / 运行时 `O`
- [ ] 逻辑地址 vs 物理地址 `O`
- [ ] MMU(Memory Management Unit) `O`
- [ ] 动态加载与动态链接 / 共享库 `S`

### 6.2 连续内存分配
- [ ] 基址/限长寄存器(Base/Limit Register) `O`
- [ ] 分配策略：首次适配(First-Fit) / 最佳适配(Best-Fit) / 最差适配(Worst-Fit)
- [ ] 外部碎片(External Fragmentation) / 内部碎片(Internal Fragmentation)
- [ ] 紧凑(Compaction)

### 6.3 分段 (Segmentation)
- [ ] 段表（基址 + 限长）`O`
- [ ] 保护与共享

### 6.4 分页 (Paging)
- [ ] 页(Page) 与页帧(Frame) `O`
- [ ] 页表(Page Table) 结构与 PTE(Page Table Entry) `O`
- [ ] 多级页表（二级、三级、四级、五级）`O`
- [ ] 哈希页表 / 反转页表(Inverted Page Table)
- [ ] x86 页表遍历(Page Table Walk) `O`
- [ ] 共享页(Shared Pages) 与保护位

### 6.5 TLB (Translation Lookaside Buffer)
- [ ] TLB 结构与命中/未命中 `O`
- [ ] ASID(Address Space Identifier) `O`
- [ ] TLB Shootdown（多处理器）`O`
- [ ] 大页(Huge Page) 与 TLB 效率 `O`

### 6.6 虚拟内存 (Virtual Memory)
- [ ] 按需分页(Demand Paging) `O` `F`
- [ ] 缺页中断处理(Page Fault Handling) `O`
- [x] 写时复制(Copy-on-Write, COW) `S`
- [ ] 内存映射文件与 I/O(mmap) `F` `G`

### 6.7 页面替换算法
- [ ] FIFO 替换（Belady 异常）`O`
- [ ] 最优替换(OPT) `O`
- [ ] LRU(Least Recently Used) `O`
- [ ] LRU 近似：时钟算法(Clock / Second-Chance) `O`
- [ ] Linux 页面替换：活跃/不活跃列表、MGLRU `O`

### 6.8 帧分配与抖动
- [ ] 全局 vs 局部替换 `O`
- [ ] 抖动(Thrashing) `O`
- [ ] 工作集模型(Working Set Model) `O`
- [ ] 缺页率(Page Fault Frequency) `O`

### 6.9 内核内存分配
- [ ] 伙伴系统(Buddy System) `O`
  - [ ] 内存区(Zone)：ZONE_DMA, ZONE_NORMAL, ZONE_HIGHMEM, ZONE_MOVABLE
  - [ ] 页阶(Page Order) 与分裂/合并
- [ ] Slab 分配器（SLAB / SLUB / SLOB）`O`
  - [ ] Slab 缓存、对象缓存
  - [ ] `kmalloc()` / `kfree()`
  - [ ] `kmem_cache_create()` / `kmem_cache_alloc()`
- [ ] `vmalloc`（虚拟连续分配）`O`
- [ ] Per-CPU 分配器 `O`
- [ ] CMA(Contiguous Memory Allocator) `O`

### 6.10 高级内存话题
- [ ] 内存压缩：zswap / zram `O`
- [ ] 透明大页(THP, Transparent Huge Pages) `O`
- [ ] 内存 cgroup 与内存限制 `O`
- [ ] OOM Killer `O`
- [ ] KSM(Kernel Same-page Merging) `O`
- [ ] NUMA 内存策略 `O`
- [ ] 交换(Swap) 机制与策略 `O`
- [ ] Linux 地址空间布局（用户空间 / 内核空间）`O`

---

## 7. 存储与 I/O 系统 (Storage & I/O)

### 7.1 I/O 硬件
- [ ] I/O 端口 / 内存映射 I/O(MMIO) `O`
- [ ] 轮询(Polling / Programmed I/O) `O`
- [ ] 中断处理 `O`
  - [ ] 中断描述符表(IDT)
  - [ ] 中断控制器：PIC / APIC / MSI
  - [ ] 上半部(Top Half) / 下半部(Bottom Half)
  - [ ] Softirq / Tasklet / Workqueue
  - [ ] 线程化中断(Threaded IRQ)
- [ ] DMA 控制器 / Scatter-Gather DMA `O`
- [ ] IOMMU `O`

### 7.2 I/O 软件分层
- [ ] 中断处理程序 `O`
- [ ] 设备驱动程序(Device Driver) `O`
- [ ] 设备无关 I/O 软件 `O`
- [ ] 用户空间 I/O `G`

### 7.3 I/O 接口
- [ ] 块设备(Block Device) vs 字符设备(Character Device) `O` `F`
- [ ] 网络设备（Sockets）`G`
- [ ] 阻塞 / 非阻塞 / 异步 I/O `G`
- [ ] 向量 I/O(readv / writev) `G`

### 7.4 I/O 多路复用与异步 I/O
- [ ] `select()` / `poll()` `G`
- [ ] `epoll()` `G`
- [ ] `io_uring` `G`
- [ ] POSIX AIO `G`

### 7.5 内核 I/O 子系统
- [ ] I/O 调度 `O`
- [ ] 缓冲(Buffering)：单缓冲 / 双缓冲 / 环形缓冲 `G`
- [ ] 缓存(Caching) `G` `F`
- [ ] 假脱机(Spooling) / 错误处理

### 7.6 磁盘与 SSD
- [ ] HDD 几何结构（磁道、扇区、柱面）
- [ ] SSD / NVMe `F`
  - [ ] Flash Translation Layer (FTL)
  - [ ] 磨损均衡(Wear Leveling)
  - [ ] TRIM / Discard
- [ ] 存储连接：SATA / SAS / NVMe / USB

### 7.7 磁盘调度
- [ ] FCFS / SCAN(电梯) / C-SCAN / LOOK / C-LOOK
- [ ] Linux I/O 调度器：Deadline / CFQ / BFQ / mq-deadline
- [ ] 多队列块层(blk-mq) `F`

### 7.8 RAID
- [ ] RAID 级别：0, 1, 5, 6, 10
- [ ] 条带化(Striping) / 镜像(Mirroring) / 奇偶校验(Parity)
- [ ] 软件 RAID(md) vs 硬件 RAID

### 7.9 Linux 块层
- [ ] `struct bio` 与请求处理 `F`
- [ ] 块设备注册 `F`
- [ ] Device Mapper(dm) `F`
- [ ] 逻辑卷管理(LVM)

### 7.10 Linux 设备模型
- [ ] kobject / kset / ktype `O`
- [ ] sysfs `O`
- [ ] 平台设备与设备树(Device Tree) `O`
- [ ] 总线-设备-驱动模型 `O`
- [ ] 热插拔(Hotplug) 与 udev `O`

---

## 8. 文件系统 (File Systems)

### 8.1 文件基础
- [ ] 文件属性（名称、类型、大小、权限、时间戳）`S` `F`
- [ ] 文件操作（create, open, read, write, seek, close）`S` `F`
- [ ] 文件描述符(File Descriptor) 与打开文件表 `S`

### 8.2 目录结构
- [ ] 树形目录 `S` `F`
- [ ] 硬链接(Hard Link) / 符号链接(Symbolic Link) `F`
- [ ] 挂载点(Mount Point) / 挂载命名空间(Mount Namespace) `F`
- [ ] Bind Mount / Overlay Mount `F`

### 8.3 文件系统实现
- [ ] 磁盘结构：引导块 / 超级块(Superblock) / inode 表 / 数据块 `F`
- [ ] 内存结构：挂载表 / 目录缓存 / 打开文件表 `F`
- [ ] 目录实现：线性表 / 哈希表 / B-tree `F`

### 8.4 空间分配策略
- [ ] 连续分配 `F`
- [ ] 链式分配（FAT）`F`
- [ ] 索引分配（inode：直接块 / 间接块 / 双重间接 / 三重间接）`F`
- [ ] 基于区段(Extent) 的分配（ext4, XFS）`F`
- [ ] B-tree 分配（Btrfs, XFS）`F`

### 8.5 空闲空间管理
- [ ] 位图(Bitmap) `F`
- [ ] 链表 / 分组 / 计数

### 8.6 VFS (Virtual File System)
- [ ] VFS 抽象层 `F` `O`
- [ ] VFS 四大对象：superblock / inode / dentry / file `F`
- [ ] VFS 操作表：`file_operations` / `inode_operations` / `super_operations` `F`
- [ ] Dentry 缓存(dcache) / Inode 缓存 `F`
- [ ] 路径名查找(Pathname Lookup) `F`

### 8.7 具体文件系统
- [ ] ext2 / ext3 / ext4 `F`
  - [ ] 块组(Block Group)、inode 结构
  - [ ] 日志(Journaling)（ext3/ext4）
  - [ ] 区段(Extents)、延迟分配(Delayed Allocation)（ext4）
- [ ] XFS（基于区段、日志、分配组）
- [ ] Btrfs（COW、B-tree、快照、子卷、校验和）
- [ ] ZFS（COW、池化存储、快照、RAIDZ）
- [ ] FAT / FAT32 / exFAT
- [ ] tmpfs / ramfs / devtmpfs
- [ ] procfs (`/proc`) / sysfs (`/sys`) / debugfs `O`
- [ ] FUSE(Filesystem in Userspace) `F`

### 8.8 日志与恢复 (Journaling & Recovery)
- [ ] 预写日志(Write-Ahead Logging, WAL) `F`
- [ ] 有序日志 vs 数据日志 `F`
- [ ] 日志结构文件系统(Log-Structured FS, LFS) `F`
- [ ] COW 文件系统 `F`
- [ ] 一致性检查(fsck) `F`
- [ ] 崩溃一致性(Crash Consistency) `F`

### 8.9 性能与缓存
- [ ] Page Cache（统一缓冲/页缓存）`F` `G`
- [ ] 预读(Read-Ahead) `F`
- [ ] 回写(Write-Back) vs 直写(Write-Through) `F`
- [ ] 回写线程(Writeback Threads) `F`

### 8.10 分布式文件系统
- [ ] NFS 协议
- [ ] 客户端缓存与一致性语义

---

## 9. 保护与安全 (Protection & Security)

### 9.1 保护机制
- [ ] 保护环(Protection Rings)：Ring 0-3 `O`
- [ ] 访问控制矩阵 / ACL(Access Control List) `F`
- [ ] 能力(Capability) 列表
- [ ] DAC(Discretionary Access Control) vs MAC(Mandatory Access Control)
- [ ] RBAC(Role-Based Access Control)

### 9.2 Linux 安全子系统
- [ ] LSM(Linux Security Modules) 框架 `O`
  - [ ] SELinux / AppArmor / SMACK
- [ ] Linux Capabilities `S`
- [ ] Seccomp / Seccomp-BPF `S`
- [ ] 命名空间(Namespace) 隔离（见 12 章）
- [ ] Cgroups 资源限制（见 12 章）

### 9.3 内存安全防护
- [ ] ASLR(Address Space Layout Randomization) `O`
- [ ] 栈保护(Stack Canary / Stack Protector) `O`
- [ ] W^X (Write XOR Execute) / NX 位 `O`
- [ ] KASLR(Kernel ASLR) `O`
- [ ] KPTI(Kernel Page Table Isolation) `O`

### 9.4 密码学基础
- [ ] 对称加密（AES）`F`
- [ ] 非对称加密（RSA, ECC）
- [ ] 哈希函数（SHA）`F`
- [ ] 数字签名与证书 / TLS

### 9.5 安全威胁
- [ ] 缓冲区溢出(Buffer Overflow) / 栈溢出 / ROP
- [ ] 侧信道攻击：Spectre / Meltdown
- [ ] Spectre/Meltdown 缓解措施 `O`

---

## 10. 虚拟化 (Virtualization)

### 10.1 虚拟机概念
- [ ] 陷入并模拟(Trap-and-Emulate) `O`
- [ ] 二进制翻译(Binary Translation)

### 10.2 硬件虚拟化支持
- [ ] Intel VT-x / AMD-V `O`
- [ ] 扩展页表(EPT) / 嵌套页表(NPT)
- [ ] IOMMU / VT-d / AMD-Vi
- [ ] SR-IOV

### 10.3 Hypervisor 类型
- [ ] Type 1（裸金属）：Xen, VMware ESXi, Hyper-V
- [ ] Type 2（托管）：VirtualBox, QEMU

### 10.4 Linux KVM
- [ ] KVM 架构（kvm.ko）`O`
- [ ] QEMU/KVM 集成 `O`
- [ ] vCPU 管理 / 内存管理（影子页表、EPT）
- [ ] Virtio 设备驱动（半虚拟化）
- [ ] 设备直通(Passthrough) / VFIO

### 10.5 OS 级虚拟化（容器）
- [ ] 容器 vs 虚拟机
- [ ] Linux 命名空间：PID / Network / Mount / UTS / IPC / User / Cgroup
- [ ] Cgroups（资源控制）
- [ ] 联合/叠加文件系统(Union / Overlay FS)
- [ ] Docker / LXC / Podman
- [ ] OCI 标准

---

## 11. 网络 (Networking)

### 11.1 网络基础（OS 视角）
- [ ] OSI 与 TCP/IP 模型 `G`
- [ ] Socket API：流式 / 数据报 / 原始 `G`
- [ ] 客户端-服务端模型 `G`

### 11.2 Linux 网络栈
- [ ] Socket 层 `G`
  - [ ] Socket 类型：SOCK_STREAM / SOCK_DGRAM / SOCK_RAW
  - [ ] Socket 族：AF_INET / AF_INET6 / AF_UNIX / AF_NETLINK
- [ ] 传输层 `G`
  - [ ] TCP 状态机
  - [ ] TCP 拥塞控制：Reno / CUBIC / BBR
  - [ ] UDP
- [ ] 网络层 `G`
  - [ ] 路由子系统（FIB、路由表）
  - [ ] Netfilter / iptables / nftables
  - [ ] 连接跟踪(Conntrack) / NAT
- [ ] 链路层 `G`
  - [ ] 网络设备驱动接口(NAPI)
  - [ ] 桥接(Bridge) / VLAN / 隧道(VXLAN, GRE, WireGuard)

### 11.3 关键数据结构
- [ ] `struct socket` / `struct sock` / `struct sk_buff` `G`
- [ ] `struct net_device` `G`

### 11.4 高级网络特性
- [ ] XDP(eXpress Data Path) `G`
- [ ] TC(Traffic Control) 与排队规则 `G`
- [ ] eBPF 网络应用 `G`
- [ ] Netlink Socket（内核-用户空间通信）`G`
- [ ] 网络命名空间 `G`
- [ ] 虚拟网络设备：veth / tun/tap / macvlan `G`
- [ ] RSS / GRO / TSO `G`
- [ ] 零拷贝网络(Zero-Copy)：sendfile / splice / MSG_ZEROCOPY `G`

---

## 12. Linux 内核专题 (Linux Kernel Specifics)

### 12.1 内核启动与初始化
- [ ] 固件(BIOS / UEFI) `O`
- [ ] 引导加载程序(Bootloader)：GRUB / systemd-boot `O`
- [ ] 内核解压与早期设置 `O`
- [ ] `start_kernel()` 与子系统初始化 `O`
- [ ] initramfs / initrd `O`
- [ ] Init 进程(PID 1)：sysvinit / Upstart / systemd `O`

### 12.2 中断与异常处理
- [ ] 异常类型：故障(Fault) / 陷阱(Trap) / 中止(Abort) `O`
- [ ] 硬件中断(IRQ) `O`
  - [ ] IRQ 分配与共享
  - [ ] 中断亲和性(smp_affinity)

### 12.3 定时器与时间管理
- [ ] 硬件时钟：PIT / HPET / TSC / APIC Timer `O`
- [ ] jiffies 与 HZ `O`
- [ ] 高精度定时器(hrtimer) `O`
- [ ] 无滴答内核(Tickless / NO_HZ) `O`
- [ ] 时钟源(Clocksource) 与时钟事件(Clockevent) 框架 `O`
- [ ] POSIX 时钟与定时器

### 12.4 内核模块
- [ ] 模块加载/卸载：insmod / rmmod / modprobe `O`
- [ ] 模块参数与依赖 `O`
- [ ] DKMS

### 12.5 进程管理细节
- [ ] `task_struct` 详解 `O`
- [ ] 内核线程(kthread) `O`
- [ ] 进程凭证(uid, gid, capabilities) `S`
- [ ] 进程命名空间(Namespace) `S`
- [ ] Cgroups v1 / v2 `S` `G`
  - [ ] CPU 控制器
  - [ ] 内存控制器
  - [ ] I/O 控制器
  - [ ] PID 控制器

### 12.6 电源管理
- [ ] ACPI 子系统
- [ ] 系统睡眠状态(S0-S5)
- [ ] 挂起到 RAM(S3) / 挂起到磁盘(S4 / Hibernate)
- [ ] CPUFreq 调速器：performance / powersave / schedutil
- [ ] CPU 空闲(cpuidle)
- [ ] 热管理(Thermal Management)

### 12.7 追踪与调试
- [ ] printk 与内核日志级别 `O`
- [ ] ftrace（函数追踪器）`O`
- [ ] Tracepoint（静态插桩）`O`
- [ ] kprobe / kretprobe（动态插桩）`O`
- [ ] uprobe（用户空间探针）
- [ ] perf_events / perf 工具 `*`
- [ ] eBPF `G` `O`
  - [ ] BPF 程序类型：kprobe / tracepoint / XDP / tc / cgroup
  - [ ] BCC / bpftrace / libbpf
  - [ ] CO-RE(Compile Once - Run Everywhere)
- [ ] 内存检测工具 `O`
  - [ ] KASAN(Kernel Address Sanitizer)
  - [ ] UBSAN(Undefined Behavior Sanitizer)
  - [ ] KMEMLEAK
  - [ ] KCSAN(Kernel Concurrency Sanitizer)
- [ ] Lockdep `O`
- [ ] kdump / crash（内核崩溃转储）`O`
- [ ] KGDB

### 12.8 内核构建系统
- [ ] Kconfig 配置系统 `O`
- [ ] Kbuild / Makefile 系统 `O`
- [ ] 交叉编译(Cross-Compilation) `O`

### 12.9 内核密码子系统
- [ ] 内核 Crypto API
- [ ] 硬件加速（AES-NI, ARM Crypto Extensions）
- [ ] dm-crypt / LUKS `F`

---

## 13. 分布式系统 (Distributed Systems)

- [ ] 13.1 分布式系统概念：透明性 / CAP 定理
- [ ] 13.2 通信：消息传递 / RPC / gRPC
- [ ] 13.3 分布式协调
  - [ ] 时钟同步：NTP / Lamport 时间戳 / 向量时钟(Vector Clock)
  - [ ] 共识算法：Paxos / Raft
  - [ ] 两阶段提交(2PC) / 三阶段提交(3PC)
- [ ] 13.4 分布式文件系统：NFS / GFS / HDFS / Ceph
- [ ] 13.5 分布式事务：ACID / 日志与恢复

---

## 14. 高级与前沿话题 (Advanced Topics)

### 14.1 多处理器与多核 OS
- [ ] 缓存一致性协议：MESI / MOESI `O`
- [ ] 内存一致性模型：Sequential / TSO / Relaxed `O`
- [ ] 无锁(Lock-Free) 与无等待(Wait-Free) 数据结构 `G`
- [ ] 可扩展锁：MCS / CLH / qspinlock `O`
- [ ] Per-CPU 数据 `O`
- [ ] NUMA 拓扑与 NUMA 感知设计 `O`

### 14.2 面向新硬件的 OS
- [ ] 异构计算（CPU + GPU + 加速器）
- [ ] 持久化内存(Persistent Memory)：Intel Optane / CXL
- [ ] SmartNIC / DPU
- [ ] NVDIMM

### 14.3 OS 安全加固
- [ ] 控制流完整性(CFI, Control Flow Integrity)
- [ ] 安全启动(Secure Boot) / 可信启动(Trusted Boot)
- [ ] TPM(Trusted Platform Module)
- [ ] Intel SGX / ARM TrustZone / AMD SEV

### 14.4 OS 设计研究
- [ ] 微内核验证：seL4
- [ ] Unikernel：MirageOS / Unikraft
- [ ] Library OS：Drawbridge / Graphene
- [ ] Multikernel：Barrelfish
- [ ] 形式化验证内核

### 14.5 可观测性与性能
- [ ] USE 方法（Utilization / Saturation / Errors）`*`
- [ ] RED 方法（Rate / Errors / Duration）`*`
- [ ] perf 性能分析 `*`
- [ ] 火焰图(Flame Graph) `*`
- [ ] 基准测试：LMBench / sysbench / fio `*`

---

## 知识点统计

| 大类 | 条目数 | 主力项目 |
|------|--------|----------|
| 1. 基础与概览 | ~15 | Zig OS |
| 2. 进程管理 | ~30 | Shell, Zig OS |
| 3. 线程与并发 | ~15 | Gateway |
| 4. 同步 | ~35 | Gateway, Zig OS |
| 5. 死锁 | ~8 | Gateway |
| 6. 内存管理 | ~45 | Zig OS |
| 7. 存储与 I/O | ~35 | Zig OS, FUSE FS |
| 8. 文件系统 | ~40 | FUSE FS |
| 9. 保护与安全 | ~20 | Zig OS, Shell |
| 10. 虚拟化 | ~15 | Zig OS |
| 11. 网络 | ~25 | Gateway |
| 12. Linux 内核专题 | ~40 | Zig OS |
| 13. 分布式系统 | ~10 | — |
| 14. 高级话题 | ~20 | Zig OS |
| **合计** | **~353** | |

---

## 项目 ↔ 知识域映射

```
┌─────────────────────────────────────────────────────────────────────┐
│                        OS 知识域                                     │
│                                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │ 01_Shell │  │02_Gateway│  │03_FUSE_FS│  │   04_Zig_OS      │   │
│  │          │  │          │  │          │  │                  │   │
│  │ 进程管理 │  │ 线程并发 │  │ 文件系统 │  │ 全部内核子系统   │   │
│  │ 系统调用 │  │ 同步原语 │  │ 块层/VFS │  │ 内存管理         │   │
│  │ 信号处理 │  │ 事件驱动 │  │ 日志恢复 │  │ 调度器           │   │
│  │ 管道/重定│  │ 网络栈   │  │ 加密     │  │ 中断/异常        │   │
│  │ 向/Job   │  │ I/O多路  │  │ 崩溃一致 │  │ 设备驱动         │   │
│  │ Control  │  │ 复用     │  │ 性       │  │ 虚拟化           │   │
│  │          │  │ 内存映射 │  │          │  │ 安全/启动        │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────────────┘   │
│       ▲              ▲              ▲               ▲               │
│       │              │              │               │               │
│    用户态          用户态+内核    用户态(FUSE)     裸金属            │
│    POSIX API       epoll/io_uring +内核概念      无 OS 依赖        │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 参考来源

- [OSC] Silberschatz, "Operating System Concepts" 10th Ed.
- [OSTEP] Arpaci-Dusseau, "Operating Systems: Three Easy Pieces"
- [MOS] Tanenbaum, "Modern Operating Systems" 4th Ed.
- [MIT 6.1810] MIT xv6 Labs
- [CS140] Stanford Pintos
- [CS162] UC Berkeley
- [LK] Linux Kernel Documentation (docs.kernel.org)
- [LKM] Interactive Linux Kernel Map (makelinux.github.io)
