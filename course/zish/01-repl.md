# 基础 REPL

- 写作时间：`2026-03-12 首次提交，2026-03-23 最近修改`
- 当前字符：`6307`

> 前置理论：[进程生命周期](/process/01-lifecycle)、[信号](/process/02-signal)

本课目标：实现一个能解析并执行命令的 shell，支持管道、重定向和基本信号处理。

## 验收标准

- 能解析并执行单个命令（如 `ls -l`）
- 支持输出重定向 `>` 和输入重定向 `<`
- 支持管道 `ls | grep foo`
- Ctrl+C 终止子进程但不杀死 shell
- 不留僵尸进程
- `cd` 和 `exit` 作为内建命令正确工作

## 设计与实现指导

REPL = Read-Eval-Print Loop（读取-执行-打印 循环）。Shell 的核心就是一个 REPL：显示提示符 → 读一行输入 → 执行 → 回到开头。

**zish 使用 Zig nightly（0.16-dev）开发。**

**IO：用原始系统调用，不用 buffered I/O**

Shell 的 REPL 每轮都要 fork。buffered I/O（如 `std.Io`）在用户态维护缓冲区，fork 后父子进程各持一份相同的缓冲区副本，两边各自 flush 会导致内容重复输出。更严重的是，如果 I/O 库内部使用线程（如 `Io.Threaded`），fork 后线程消失但锁状态被复制，可能死锁。

所有真实的 shell（bash、zsh、dash、fish）都用 raw `read()`/`write()` 做 REPL。这两个系统调用在 async-signal-safe 清单上，没有锁，没有缓冲区，没有线程，fork 对它们没有任何影响。

提示符和读取输入：

```zig
const linux = std.os.linux;

// print prompt — write is unbuffered, no flush needed
_ = linux.write(1, "zish> ", 6);

// read one line
var line_buf: [4096]u8 = undefined;
const n = linux.read(0, &line_buf, line_buf.len);
if (n == 0) break;  // EOF (Ctrl+D)

const line = line_buf[0..n - 1];  // strip trailing '\n'
```

`write(1, ...)` 直接写 fd 1（stdout），`read(0, ...)` 直接读 fd 0（stdin）。没有缓冲区，不需要 flush，fork 安全。

**API 签名速查**

信号 / 终端控制在 `std.posix` 下，底层 Linux 系统调用在 `std.os.linux` 下。

| API | 签名 | 说明 |
|-----|------|------|
| `read` | `std.os.linux.read(fd: i32, buf: [*]u8, count: usize) usize` | 读取，返回实际读取字节数；0 表示 EOF |
| `write` | `std.os.linux.write(fd: i32, buf: [*]const u8, count: usize) usize` | 写入，返回实际写入字节数 |
| `fork` | `std.os.linux.fork() usize` | 返回 0 → 子进程，>0 → 父进程（返回类型为 `usize`） |
| `execve` | `std.os.linux.execve(path, argv, envp)` | 成功不返回；不搜索 PATH，需手动实现 PATH 查找 |
| `waitpid` | `std.os.linux.waitpid(pid, &status, flags)` | `status` 以指针传入；flags=0 阻塞，`W.NOHANG` 非阻塞 |
| `chdir` | `std.posix.chdir(dir_path: []const u8) ChangeCurDirError!void` | 接受普通切片，不要求 null 结尾 |
| `open` | `std.os.linux.open(path, flags, mode) usize` | 打开文件，返回 fd（`usize`） |
| `pipe` | `std.os.linux.pipe(fd: *[2]i32) usize` | `fds[0]` 读端，`fds[1]` 写端 |
| `dup2` | `std.os.linux.dup2(old: i32, new: i32) usize` | 让 new 成为 old 的副本 |
| `close` | `std.os.linux.close(fd: fd_t) usize` | 关闭文件描述符 |
| `exit` | `std.os.linux.exit(status: i32) noreturn` | 参数 i32 |

Wait 状态解析：

```zig
var status: u32 = undefined;
_ = std.os.linux.waitpid(@intCast(pid), &status, 0);
if (std.posix.W.IFEXITED(status)) {
    const exit_code = std.posix.W.EXITSTATUS(status);
}
```

**Null-terminated 字符串处理**

`execve` 要求所有参数都是 null-terminated（`[*:0]const u8` 和 `[*:null]const ?[*:0]const u8`），但 Zig 的 `[]u8` 切片不带 null。**不能直接 `@ptrCast`**。

思路是**原地写 `\0`**：读入一行后在 buffer 上把空格替换成 `\0`，末尾也写 `\0`，每个 token 的起始指针 cast 成 `[*:0]const u8` 就是合法的：

```
Input: "ls -la /tmp"
      ┌──┬──┬───┬──┬───┬───┬───┬───┬───┬───┬───┬──┐
buf:  │l │s │ \0│- │l  │a  │ \0│/  │t  │m  │p  │\0│
      └──┴──┴───┴──┴───┴───┴───┴───┴───┴───┴───┴──┘
       ↑         ↑              ↑
    args[0]   args[1]        args[2]          args[3] = null
```

**Build 配置**

`build.zig` 关键变化：`root_source_file` 必须包在 `root_module = b.createModule(...)` 里：

```zig
const exe = b.addExecutable(.{
    .name = "zish",
    .root_module = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    }),
});
```

`build.zig.zon` 中 `.name` 是 enum literal（不是字符串），`.fingerprint` 必填（第一次编译时从报错信息里复制）。

**重定向**

重定向的原理在[进程生命周期](/process/01-lifecycle)的文件描述符一节已经讲过：在子进程中，exec 之前，用 `open` + `dup2` 把 stdout 指向文件。

实现分两步。

**解析**：在参数列表中找到 `>` 或 `<`，提取后面的文件名，并把这两个 token（`>` 和文件名）从 argv 中去掉。`ls > output.txt` 解析后，argv 只剩 `{"ls", null}`，另外记住输出文件是 `output.txt`。

**子进程中执行**：fork 之后、exec 之前，根据解析结果做重定向：

```zig
// output redirection: ls > output.txt
// in child process, before exec:
const linux = std.os.linux;
const file: i32 = @bitCast(@as(u32, @truncate(linux.open(
    filename,
    .{ .ACCMODE = .WRONLY, .CREAT = true, .TRUNC = true },
    0o644,
))));
_ = linux.dup2(file, 1);  // fd 1 now points to file
_ = linux.close(file);    // original fd no longer needed
// then exec...
```

输入重定向 `<` 同理，把 `WRONLY` 换成 `RDONLY`，把 `1`（stdout）换成 `0`（stdin）：

```zig
// input redirection: sort < data.txt
const file: i32 = @bitCast(@as(u32, @truncate(linux.open(filename, .{ .ACCMODE = .RDONLY }, 0))));
_ = linux.dup2(file, 0);
_ = linux.close(file);
```

`open` 的第一个参数要求 null-terminated（`[*:0]const u8`）。解析时用和 argv 相同的原地写 `\0` 方式处理文件名就行。

**信号处理**

shell 必须忽略 SIGINT，否则 Ctrl+C 会杀死 shell 自己。但子进程需要在 fork 后、exec 前重置 SIGINT 为 SIG_DFL，否则子进程也会继承 SIG_IGN。完整原理见[信号](/process/02-signal)的信号继承一节。

Zig 的 sigaction 在 `std.posix` 下：

```zig
pub fn sigaction(sig: SIG, noalias act: ?*const Sigaction, noalias oact: ?*Sigaction) void
```

Sigaction 结构体：

```zig
pub const Sigaction = struct {
    handler: extern union {
        handler: ?handler_fn,     // fn (i32) callconv(.c) void
        sigaction: ?sigaction_fn,  // fn (i32, *siginfo_t, ?*anyopaque) callconv(.c) void
    },
    mask: sigset_t,
    flags: c_ulong,
};
```

SIG 常量：

```zig
posix.SIG.INT   // 2  Ctrl+C
posix.SIG.DFL   // default disposition
posix.SIG.IGN   // ignore
```

SA 标志：

```zig
posix.SA.RESTART     // auto-restart interrupted slow syscalls
posix.SA.NOCLDSTOP   // no SIGCHLD when child stops
posix.SA.NOCLDWAIT   // auto-reap children (no zombies)
```

**Shell 启动时忽略 SIGINT**：

```zig
const posix = std.posix;

const ign = posix.Sigaction{
    .handler = .{ .handler = posix.SIG.IGN },
    .mask = posix.sigemptyset(),
    .flags = 0,
};
posix.sigaction(posix.SIG.INT, &ign, null);
```

**fork 后、exec 前，子进程重置 SIGINT 为默认**：

```zig
const dfl = posix.Sigaction{
    .handler = .{ .handler = posix.SIG.DFL },
    .mask = posix.sigemptyset(),
    .flags = 0,
};
posix.sigaction(posix.SIG.INT, &dfl, null);
```

**注意事项**

- **exec 失败必须 `linux.exit(1)`**：否则子进程跌回 REPL 循环，出现两个 shell 同时读 stdin
- **`cd` 和 `exit` 不能 fork**：它们修改父进程状态，fork 后改的是子进程，父进程不受影响
- **传环境变量**：`std.Io.init().environ.block.slice.ptr` 传给 `execve` 第三个参数
- **ArrayList 改为 unmanaged**：所有操作都要传 allocator（`list.append(alloc, item)`）

## 验证

```
zish> ls
build.zig  build.zig.zon  src
zish> ls > /tmp/out.txt
zish> cat /tmp/out.txt
build.zig
build.zig.zon
src
zish> cat < /tmp/out.txt
build.zig
build.zig.zon
src
zish> ls | grep src
src
zish> sleep 100
^C
zish>               ← shell 还活着
zish> cd /tmp
zish> exit
```
