// io_uring_read.c — read a file using io_uring
#include <stdio.h>
#include <fcntl.h>
#include <string.h>
#include <liburing.h>

int main() {
    struct io_uring ring;
    io_uring_queue_init(32, &ring, 0);   // 创建 io_uring 实例，队列深度 32

    int fd = open("test.txt", O_RDONLY);
    char buf[4096];
    memset(buf, 0, sizeof(buf));

    // 第一步：获取 SQE 并填入读操作
    struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
    io_uring_prep_read(sqe, fd, buf, sizeof(buf), 0);
    sqe->user_data = 42;                 // 自定义标识，在 CQE 中原样返回

    // 第二步：提交
    io_uring_submit(&ring);

    // 第三步：等待并收割 CQE
    struct io_uring_cqe *cqe;
    io_uring_wait_cqe(&ring, &cqe);      // 等待至少一个完成事件
    if (cqe->res > 0)
        printf("read %d bytes: %.*s\n", cqe->res, cqe->res, buf);
    io_uring_cqe_seen(&ring, cqe);       // 标记 CQE 已消费，推进 CQ head

    close(fd);
    io_uring_queue_exit(&ring);
}
