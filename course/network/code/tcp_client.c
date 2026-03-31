// tcp_client.c — 连接 echo server，发送消息并读回回显
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <arpa/inet.h>

int main(void) {
    // 创建 TCP socket
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) { perror("socket"); exit(1); }

    // 服务端地址：127.0.0.1:9000
    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_port   = htons(9000),
    };
    inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);

    // 发起连接（内核在此完成三次握手）
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        perror("connect");
        close(fd);
        exit(1);
    }

    // 发送数据
    const char *msg = "hello from client";
    write(fd, msg, strlen(msg));

    // 读回回显
    char buf[1024];
    ssize_t n = read(fd, buf, sizeof(buf) - 1);
    if (n > 0) {
        buf[n] = '\0';
        printf("received: %s\n", buf);
    }

    close(fd);
    return 0;
}
