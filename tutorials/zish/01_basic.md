# zish 01: 基础 REPL

REPL = Read-Eval-Print Loop（读取-执行-打印 循环）。Shell 的核心就是一个 REPL：显示提示符 → 读一行输入 → 执行 → 回到开头。

Zig 0.15 API 速查 + fork/exec/wait 实现指导。原理见 [process/01_lifecycle.md](../process/01_lifecycle.md)。

---

## 1. IO（Zig 0.15 新 API）

旧的 `std.io.getStdIn()` 已移除。现在通过 `std.fs.File` 获取，reader/writer 必须自带 buffer。

### 获取标准文件

```zig
const stdin_file = std.fs.File.stdin();
const stdout_file = std.fs.File.stdout();
const stderr_file = std.fs.File.stderr();
```

### 创建 Reader / Writer

```zig
var stdin_buf: [8192]u8 = undefined;
var stdout_buf: [4096]u8 = undefined;

var stdin = stdin_file.reader(&stdin_buf);
var stdout = stdout_file.writer(&stdout_buf);
```

buffer 在栈上分配，大小自己定。

### Reader 关键方法

通过 `.interface` 访问（类型是 `std.Io.Reader`）：

| 方法 | 签名 | 说明 |
|------|------|------|
| `peek` | `peek(n: usize) Error![]u8` | 查看 buffer 中下 n 字节，不消费 |
| `toss` | `toss(n: usize) void` | 丢弃已 peek 的字节 |
| `takeByte` | `takeByte() Error!u8` | 读一个字节 |
| `takeDelimiterExclusive` | `takeDelimiterExclusive(delimiter: u8) DelimiterError![]u8` | 读到 delimiter 为止（不含） |
| `readSliceAll` | `readSliceAll(buffer: []u8) Error!void` | 填满整个 buffer |
| `readSliceShort` | `readSliceShort(buffer: []u8) ShortError!usize` | 读到有多少算多少 |

**没有 `readUntilDelimiterAlloc`**。读一行要自己写循环，参考下面的 readLine。

### Writer 关键方法

同样通过 `.interface` 访问（类型是 `std.Io.Writer`）：

| 方法 | 签名 | 说明 |
|------|------|------|
| `print` | `print(comptime fmt: []const u8, args: anytype) Error!void` | 格式化输出 |
| `writeAll` | `writeAll(bytes: []const u8) Error!void` | 写入全部字节 |
| `writeByte` | `writeByte(byte: u8) Error!void` | 写一个字节 |
| `write` | `write(bytes: []const u8) Error!usize` | 写入，返回实际写入量 |
| `flush` | `flush() Error!void` | 刷新 buffer 到底层文件 |

### **必须 flush**

writer 带 buffer，`print` 后数据可能还在 buffer 里。不 flush 就看不到输出——prompt 尤其如此：

```zig
stdout.interface.print("zish> ", .{}) catch {};
stdout.interface.flush() catch {};
```

### readLine 参考实现

来自 mcp-ascii-align，用 `peek` + `toss` 逐字节读：

```zig
fn readLine(alloc: Allocator, reader: *std.Io.Reader) !?[]u8 {
    var line: ArrayList(u8) = .empty;
    errdefer line.deinit(alloc);

    while (true) {
        const buf = reader.peek(1) catch |err| switch (err) {
            error.EndOfStream => {
                if (line.items.len > 0) return try line.toOwnedSlice(alloc);
                return null;
            },
            else => return err,
        };
        if (buf.len == 0) {
            if (line.items.len > 0) return try line.toOwnedSlice(alloc);
            return null;
        }
        if (buf[0] == '\n') {
            reader.toss(1);
            return try line.toOwnedSlice(alloc);
        }
        try line.append(alloc, buf[0]);
        reader.toss(1);
    }
}
```

调用：`readLine(alloc, &stdin.interface)`

返回 `null` 表示 EOF。

---

## 2. POSIX API 签名速查

全部在 `std.posix` 下。

### fork

```zig
pub fn fork() ForkError!pid_t
```

- 返回 0 → 子进程
- 返回 >0 → 父进程（值是子进程 PID）

### execvpeZ

```zig
pub fn execvpeZ(
    file: [*:0]const u8,
    argv_ptr: [*:null]const ?[*:0]const u8,
    envp: [*:null]const ?[*:0]const u8,
) ExecveError
```

- **成功不返回**，失败返回 error
- `file` 会搜索 PATH
- 三个参数全部要求 null-terminated（见第 3 节）
- 传当前环境：`std.c.environ`

另有 `execveZ`，第一个参数是绝对路径，不搜 PATH。

### waitpid

```zig
pub fn waitpid(pid: pid_t, flags: u32) WaitPidResult

pub const WaitPidResult = struct {
    pid: pid_t,
    status: u32,
};
```

- `flags` 传 0 → 阻塞等待
- `flags` 传 `std.posix.W.NOHANG` → 非阻塞

解析 status（`W` = Wait，这些宏来自 POSIX 的 `<sys/wait.h>`）：

```zig
const result = std.posix.waitpid(pid, 0);
if (std.posix.W.IFEXITED(result.status)) {
    const exit_code = std.posix.W.EXITSTATUS(result.status);
}
```

| 宏 | 签名 | 说明 |
|----|------|------|
| `W.IFEXITED` | `(u32) bool` | 是否正常退出 |
| `W.EXITSTATUS` | `(u32) u8` | 退出码 |
| `W.TERMSIG` | `(u32) u32` | 终止信号 |

### chdir

```zig
pub fn chdir(dir_path: []const u8) ChangeCurDirError!void
```

**接受 `[]const u8`**（普通 Zig 切片），不要求 null 结尾。这是例外。

### pipe

```zig
pub fn pipe() PipeError![2]fd_t
```

- `fds[0]` = 读端
- `fds[1]` = 写端

另有 `pipe2(flags: O)` 可设置 `O.CLOEXEC` 等。

### dup2

```zig
pub fn dup2(old_fd: fd_t, new_fd: fd_t) !void
```

让 `new_fd` 成为 `old_fd` 的副本。重定向用法：

```zig
// 将 stdout 重定向到文件
const fd = try std.posix.open("out.txt", .{ .ACCMODE = .WRONLY, .CREAT = true, .TRUNC = true }, 0o644);
try std.posix.dup2(fd, std.posix.STDOUT_FILENO);
std.posix.close(fd);
```

### close

```zig
pub fn close(fd: fd_t) void
```

不返回 error。

### open

```zig
pub fn open(file_path: []const u8, flags: O, perm: mode_t) OpenError!fd_t
pub fn openZ(file_path: [*:0]const u8, flags: O, perm: mode_t) OpenError!fd_t
```

`open` 接受切片，`openZ` 接受 null-terminated。

### exit

```zig
pub fn exit(status: u8) noreturn
```

参数是 `u8`，返回类型是 `noreturn`。

### 标准文件描述符常量

```zig
std.posix.STDIN_FILENO   // 0
std.posix.STDOUT_FILENO  // 1
std.posix.STDERR_FILENO  // 2
```

---

## 3. Null-terminated 字符串处理

### 问题

`execvpeZ` 要求所有参数都是 null-terminated：

- 命令：`[*:0]const u8`
- argv 数组：`[*:null]const ?[*:0]const u8`

但 Zig 的 `[]u8` 切片不带 null，`std.mem.splitScalar` 返回的子切片也不带。**不能直接 `@ptrCast`**——看起来能跑，实际在读切片边界之外的内存。

### 思路：原地写 `\0`

读入一行后，在 buffer 上原地操作：把空格替换成 `\0`，末尾也写 `\0`。每个 token 的起始指针 cast 成 `[*:0]const u8` 就是合法的，因为后面一定有 `\0` 终止。

```
输入: "ls -la /tmp"
      ┌──┬──┬───┬──┬───┬───┬───┬───┬───┬───┬───┬──┐
buf:  │l │s │ \0│- │l  │a  │ \0│/  │t  │m  │p  │\0│
      └──┴──┴───┴──┴───┴───┴───┴───┴───┴───┴───┴──┘
       ↑         ↑              ↑
    args[0]   args[1]        args[2]          args[3] = null
```

要点：

- `readLine` 返回的是 `buf` 的切片，可以直接改 `buf`
- token 起始指针用 `@ptrCast` 转成 `[*:0]const u8`
- args 数组最后一项设为 `null`

---

## 4. Build 配置

### build.zig

```zig
const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const exe = b.addExecutable(.{
        .name = "zish",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    b.installArtifact(exe);

    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    if (b.args) |args| run_cmd.addArgs(args);

    const run_step = b.step("run", "Run the shell");
    run_step.dependOn(&run_cmd.step);
}
```

关键变化：`root_source_file` 必须包在 `root_module = b.createModule(...)` 里。

### build.zig.zon

```zig
.{
    .name = .zish,
    .version = "0.1.0",
    .fingerprint = 0x...,  // 编译器报错时会给出具体值
    .paths = .{
        "build.zig",
        "build.zig.zon",
        "src",
    },
}
```

- `.name` 是 enum literal，不是字符串
- 带横杠的名字用 `.@"my-name"`
- `.fingerprint` 必填，第一次编译时从报错信息里复制

---

## 5. 注意事项

- **exec 失败必须 `posix.exit(1)`**：否则子进程跌回 REPL 循环，出现两个 shell 同时读 stdin
- **`cd` 和 `exit` 不能 fork**：它们修改父进程状态，fork 后改的是子进程，父进程不受影响
- **传环境变量**：`std.c.environ` 直接传给 `execvpeZ` 第三个参数
- **`align` 是关键字**：不能用作变量名或 import 名
- **ArrayList 改为 unmanaged**：所有操作都要传 allocator（`list.append(alloc, item)`）
