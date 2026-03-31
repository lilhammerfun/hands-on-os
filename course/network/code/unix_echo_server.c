// unix_echo_server.c — AF_UNIX echo server
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/un.h>

#define SOCKET_PATH "/tmp/echo.sock"

int main(void) {
    // 删除上次运行可能留下的 socket 文件
    unlink(SOCKET_PATH);

    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) { perror("socket"); exit(1); }

    // AF_UNIX 的地址是文件路径，不是 IP + 端口
    struct sockaddr_un addr = { .sun_family = AF_UNIX };
    strncpy(addr.sun_path, SOCKET_PATH, sizeof(addr.sun_path) - 1);

    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        perror("bind"); exit(1);
    }
    listen(fd, 5);
    printf("listening on %s\n", SOCKET_PATH);

    // 和 AF_INET 一样：accept 返回新 fd 用于数据传输
    int client = accept(fd, NULL, NULL);
    if (client < 0) { perror("accept"); exit(1); }

    char buf[1024];
    ssize_t n;
    while ((n = read(client, buf, sizeof(buf))) > 0)
        write(client, buf, n);

    close(client);
    close(fd);
    unlink(SOCKET_PATH);  // 清理 socket 文件
    return 0;
}
