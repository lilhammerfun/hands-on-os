// fd_passing.c — 通过 AF_UNIX socket 传递文件描述符（SCM_RIGHTS）
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <fcntl.h>

// 发送一个 fd 到对端
static void send_fd(int sock, int fd_to_send) {
    // sendmsg 要求至少有 1 字节的普通数据
    char dummy = 'F';
    struct iovec iov = { .iov_base = &dummy, .iov_len = 1 };

    // 辅助数据(ancillary data)携带 fd
    char cmsg_buf[CMSG_SPACE(sizeof(int))];
    memset(cmsg_buf, 0, sizeof(cmsg_buf));

    struct msghdr msg = {
        .msg_iov        = &iov,
        .msg_iovlen     = 1,
        .msg_control    = cmsg_buf,
        .msg_controllen = sizeof(cmsg_buf),
    };

    struct cmsghdr *cmsg = CMSG_FIRSTHDR(&msg);
    cmsg->cmsg_level = SOL_SOCKET;
    cmsg->cmsg_type  = SCM_RIGHTS;      // "我要传递文件描述符"
    cmsg->cmsg_len   = CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(cmsg), &fd_to_send, sizeof(int));

    if (sendmsg(sock, &msg, 0) < 0) {
        perror("sendmsg");
        exit(1);
    }
}

// 从对端接收一个 fd
static int recv_fd(int sock) {
    char dummy;
    struct iovec iov = { .iov_base = &dummy, .iov_len = 1 };

    char cmsg_buf[CMSG_SPACE(sizeof(int))];
    struct msghdr msg = {
        .msg_iov        = &iov,
        .msg_iovlen     = 1,
        .msg_control    = cmsg_buf,
        .msg_controllen = sizeof(cmsg_buf),
    };

    if (recvmsg(sock, &msg, 0) < 0) {
        perror("recvmsg");
        exit(1);
    }

    struct cmsghdr *cmsg = CMSG_FIRSTHDR(&msg);
    int fd;
    memcpy(&fd, CMSG_DATA(cmsg), sizeof(int));
    return fd;
}

int main(void) {
    // socketpair 创建一对已连接的 AF_UNIX socket
    int sv[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) < 0) {
        perror("socketpair");
        exit(1);
    }

    pid_t pid = fork();
    if (pid < 0) { perror("fork"); exit(1); }

    if (pid == 0) {
        // 子进程：打开文件，把 fd 发给父进程
        close(sv[0]);

        int file_fd = open("/etc/hostname", O_RDONLY);
        if (file_fd < 0) { perror("open"); exit(1); }

        printf("child: opened /etc/hostname as fd %d, sending to parent\n",
               file_fd);
        send_fd(sv[1], file_fd);

        close(file_fd);
        close(sv[1]);
        exit(0);
    }

    // 父进程：接收子进程传过来的 fd
    close(sv[1]);

    int received_fd = recv_fd(sv[0]);
    printf("parent: received fd %d from child\n", received_fd);

    // 用收到的 fd 读取文件内容
    char buf[256];
    ssize_t n = read(received_fd, buf, sizeof(buf) - 1);
    if (n > 0) {
        buf[n] = '\0';
        printf("parent: content = %s", buf);
    }

    close(received_fd);
    close(sv[0]);
    waitpid(pid, NULL, 0);
    return 0;
}
