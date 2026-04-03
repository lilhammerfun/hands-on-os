# 系统调用

- 写作时间：`2026-03-22 首次提交，2026-03-30 最近修改`
- 当前字符：`3518`

上一课把用户态和内核态之间的特权边界立住了。这一课就沿着那条边界，完整追踪用户程序最常见的主动入口：系统调用。

写文件、创建进程、映射内存，最终都要落到系统调用上。作为基础与概览这一章的收尾，我们会把“用户程序怎样进入内核”这件事走完：`syscall` 指令怎样切换到内核态，参数和返回值怎样在寄存器里约定，也就是 **ABI**，以及为什么像 `clock_gettime()` 这样的高频操作会借助 **vDSO** 绕过完整的模式切换。

来看一个实验。编译第一课的 `hello.c`，然后把程序自己的标准输出重定向到 `/dev/null`，只看 `strace` 记录下来的系统调用：

```
$ gcc course/basics/code/hello.c -o /tmp/hello
$ strace -e trace=execve,write,exit_group /tmp/hello >/dev/null
execve("/tmp/hello", ["/tmp/hello"], 0xffffcf17bbb0 /* 7 vars */) = 0
write(1, "hello\n", 6)                  = 6
exit_group(0)                           = ?
+++ exited with 0 +++
```

`write(1, "hello\n", 6)` 这一行，程序从用户态发出了一个请求，内核在内核态完成了实际的写入操作，然后返回用户态。中间发生了什么？

## 系统调用

系统调用(system call, syscall)是用户态程序请求内核服务的标准接口。用户程序通过系统调用让内核代为执行需要特权的操作（如读写文件、创建进程、分配内存），然后内核把结果返回给用户程序。

完整追踪一次 `write(1, "hello\n", 6)`，大致会经历这几步：

1. glibc 包装函数把系统调用号和参数放进寄存器
2. 程序执行 `syscall` 指令，CPU 从用户态切换到内核态
3. 内核从 `entry_SYSCALL_64` 入口保存现场，切到内核栈
4. `do_syscall_64` 根据系统调用号查 `sys_call_table`
5. 对应的处理函数真正完成工作，比如 `sys_write`
6. 返回值写回 `rax`，执行 `sysretq` 回到用户态

关键寄存器约定如下：

| 寄存器 | 含义 |
|--------|------|
| `rax` | 系统调用号 / 返回值 |
| `rdi` | 第 1 个参数 |
| `rsi` | 第 2 个参数 |
| `rdx` | 第 3 个参数 |

Linux x86-64 的系统调用表定义在 `arch/x86/entry/syscalls/syscall_64.tbl` 中，比如：

```
0   common  read
1   common  write
56  common  clone
57  common  fork
59  common  execve
60  common  exit
61  common  wait4
```

这也是为什么后面讲进程管理时，`fork`、`execve`、`wait4` 都会重新回到这里：它们首先是系统调用，其次才是进程机制。

## ABI

ABI(Application Binary Interface，应用程序二进制接口)是在二进制层面定义的接口约定，规定了参数如何传递、返回值如何获取、哪些寄存器会被覆写。

API 和 ABI 不是一回事。API 是源代码层面的接口，比如 `write(fd, buf, count)`；ABI 是编译后的机器码怎样真正调用这件事。API 兼容意味着代码重新编译后还能用，ABI 兼容意味着已有的二进制文件不重新编译也能运行。

x86-64 Linux 系统调用的 ABI 规定了以下寄存器：

| 寄存器 | 用途 |
|--------|------|
| `rax` | 系统调用编号（入参），返回值（出参） |
| `rdi` | 第 1 个参数 |
| `rsi` | 第 2 个参数 |
| `rdx` | 第 3 个参数 |
| `r10` | 第 4 个参数 |
| `r8` | 第 5 个参数 |
| `r9` | 第 6 个参数 |
| `rcx` | `syscall` 覆写，用来保存返回地址 |
| `r11` | `syscall` 覆写，用来保存用户态 RFLAGS |

这里有一个容易忽略的细节：系统调用 ABI 的第 4 个参数用 `r10`，而不是 C 调用约定里的 `rcx`。原因很简单，`syscall` 指令本身会覆写 `rcx`。

## vDSO

vDSO(virtual Dynamic Shared Object)是内核映射到每个用户进程地址空间中的一小段代码和数据，让特定调用可以在用户态直接完成，不需要切换到内核态。

为什么需要它？因为不是所有系统调用都值得完整陷入一次内核。有些调用只是读取内核维护的数据，并不真正修改系统状态。`clock_gettime()`、`gettimeofday()` 就是典型例子。对这类高频只读操作来说，模式切换的固定开销太贵了。

于是内核把一小段只读代码和配套数据页映射到用户空间，glibc 发现 vDSO 可用后，就优先走这条更快的路径。可以在 `/proc/self/maps` 里看到：

```
$ cat /proc/self/maps | grep -E "vdso|vvar"
ffffa95a3000-ffffa95a5000 r--p 00000000 00:00 0                          [vvar]
ffffa95a5000-ffffa95a7000 r-xp 00000000 00:00 0                          [vdso]
```

`[vdso]` 是代码，`[vvar]` 是它读取的数据页。前者执行在用户态，后者由内核维护。这就是 vDSO 能加速高频调用的原因：它跳过了完整的陷入和返回过程。

## 小结

| 概念 | 说明 |
|------|------|
| 系统调用 | 用户态请求内核服务的标准接口 |
| `syscall` / `sysretq` | x86-64 上进入/退出内核态的快速指令 |
| `entry_SYSCALL_64` | Linux x86-64 系统调用汇编入口 |
| `sys_call_table` | 系统调用编号到处理函数的分发表 |
| ABI | 二进制层面的寄存器和调用约定 |
| vDSO | 避免部分高频调用陷入内核的用户态快路径 |

到这里，基础与概览这一章就完成了从“操作系统是什么”到“用户程序怎样进入内核”的完整铺垫。下一章终于可以把镜头推进到进程本身：当这条边界已经建立好之后，内核怎样把用户态世界真正拉起来？

---

**Linux 源码入口**：
- [`arch/x86/entry/entry_64.S`](https://elixir.bootlin.com/linux/latest/source/arch/x86/entry/entry_64.S) — `entry_SYSCALL_64`
- [`arch/x86/entry/common.c`](https://elixir.bootlin.com/linux/latest/source/arch/x86/entry/common.c) — `do_syscall_64`
- [`arch/x86/entry/syscalls/syscall_64.tbl`](https://elixir.bootlin.com/linux/latest/source/arch/x86/entry/syscalls/syscall_64.tbl) — 系统调用编号表

下一课进入进程的世界：一个程序怎么变成进程，进程怎么创建、替换和回收。
