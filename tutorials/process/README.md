# 进程管理 (Process Management)

> **一句话**：操作系统如何创建、调度、隔离和终止程序的执行实例。

---

## 这个知识域解决什么问题？

CPU 只有一个（或几个），但用户想同时运行成百上千个程序。操作系统需要回答一系列递进的问题：

1. **怎么表示一个正在运行的程序？** → 进程抽象（PCB / `task_struct`）
2. **怎么创建和销毁它？** → 生命周期（fork / exec / wait / exit）
3. **怎么让多个进程共享 CPU？** → 调度（Scheduling）
4. **进程之间怎么协作？** → 信号（Signal）、进程组（Process Group）
5. **怎么控制前后台交互？** → 会话（Session）、终端控制（Terminal Control）
6. **怎么隔离它们？** → 命名空间（Namespace）、资源限制（Cgroups）

这些问题形成一条清晰的依赖链——每一层都建立在前一层之上。

---

## 知识结构与依赖关系

```
                    ┌─────────────────────┐
                    │ 01 进程生命周期      │ ← 基石：fork/exec/wait
                    │ fork + exec + wait  │   没有这个，后面的都不存在
                    └────────┬────────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
     ┌────────────┐  ┌────────────┐  ┌────────────┐
     │ 02 信号    │  │ 03 进程组  │  │ 06 调度    │
     │ Signal     │  │ Job Control│  │ Scheduling │
     │            │  │ 会话/终端  │  │ 上下文切换 │
     └──────┬─────┘  └──────┬─────┘  └────────────┘
            │               │          (Zig OS 阶段)
            └───────┬───────┘
                    ▼
           ┌───────────────┐
           │ 04 Namespace  │ ← 隔离：在进程的基础上加"围墙"
           │ 05 Cgroups    │ ← 限制：给进程加"天花板"
           └───────────────┘
            (Shell v2 阶段)
```

**读的顺序**：按编号从 01 开始。01 是所有后续章节的前提；02 和 03 互相独立但实践中紧密配合（job control 需要信号）；04/05 依赖 01-03 的完整理解；06 可以在任何时候读，但写 Zig OS 时才会动手实现。

---

## 章节索引

| 编号 | 主题 | 核心问题 | 驱动项目 | 状态 |
|------|------|----------|----------|------|
| 01 | [进程生命周期](01_lifecycle.md) | 进程是什么？怎么创建和销毁？ | Shell v0 | 已完成 |
| 02 | [信号](02_signal.md) | 进程之间怎么发通知？Ctrl-C 做了什么？ | Shell v0 | 已完成 |
| 03 | 进程组与会话 | fg/bg/jobs 背后的状态机是什么？ | Shell v1 | 待写 |
| 04 | Namespace | 怎么让进程以为自己是整个系统唯一的？ | Shell v2 | 待写 |
| 05 | Cgroups | 怎么限制进程能用多少 CPU 和内存？ | Shell v2 | 待写 |
| 06 | 调度与上下文切换 | 内核怎么决定下一个运行谁？怎么切换？ | Zig OS | 待写 |

---

## 关键概念速查

| 概念 | 定义 | 首次出现 |
|------|------|----------|
| 进程(Process) | 程序的运行实例，拥有独立地址空间 | 01 |
| PCB / `task_struct` | 内核中描述进程的数据结构 | 01 |
| fork() | 复制当前进程 | 01 |
| exec() | 用新程序替换当前进程 | 01 |
| wait() | 等待子进程结束，回收资源 | 01 |
| 僵尸进程(Zombie) | 已退出但未被 wait 回收的进程 | 01 |
| 信号(Signal) | 进程间的异步通知机制 | 02 |
| 进程组(Process Group) | 一组相关进程，共享同一个 PGID | 03 |
| 会话(Session) | 一组进程组，绑定一个控制终端 | 03 |
| Namespace | 内核级别的资源视图隔离 | 04 |
| Cgroups | 内核级别的资源用量限制 | 05 |
| 上下文切换(Context Switch) | 保存/恢复进程的 CPU 状态 | 06 |
| 调度器(Scheduler) | 决定哪个进程获得 CPU 的内核组件 | 06 |

---

## Linux 源码入口

| 主题 | 关键文件 | 说明 |
|------|----------|------|
| 进程创建 | `kernel/fork.c` | `copy_process()`, `_do_fork()` |
| 程序执行 | `fs/exec.c` | `do_execveat_common()` |
| 进程退出 | `kernel/exit.c` | `do_exit()`, `do_wait()` |
| 信号处理 | `kernel/signal.c` | `do_send_sig_info()`, `get_signal()` |
| 调度器 | `kernel/sched/core.c` | `schedule()`, `__schedule()` |
| CFS | `kernel/sched/fair.c` | `pick_next_task_fair()`, `update_curr()` |
| Namespace | `kernel/nsproxy.c` | `create_new_namespaces()` |
| Cgroups | `kernel/cgroup/` | `cgroup_attach_task()` |
