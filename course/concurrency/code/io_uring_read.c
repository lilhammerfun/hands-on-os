#define _GNU_SOURCE

#include <fcntl.h>
#include <liburing.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv)
{
    struct io_uring ring;
    struct io_uring_cqe *cqe;
    char buffer[4096];
    int fd = -1;
    int status = EXIT_FAILURE;
    int ret;

    if (argc != 2) {
        fprintf(stderr, "usage: %s FILE\n", argv[0]);
        return EXIT_FAILURE;
    }

    ret = io_uring_queue_init(32, &ring, 0);
    if (ret < 0) {
        fprintf(stderr, "io_uring_queue_init: %s\n", strerror(-ret));
        return EXIT_FAILURE;
    }

    fd = open(argv[1], O_RDONLY | O_CLOEXEC);
    if (fd < 0) {
        perror("open");
        goto out_ring;
    }

    struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
    if (sqe == NULL) {
        fprintf(stderr, "io_uring_get_sqe: submission queue is full\n");
        goto out_close;
    }

    io_uring_prep_read(sqe, fd, buffer, sizeof(buffer) - 1, 0);
    io_uring_sqe_set_data64(sqe, 42);

    ret = io_uring_submit(&ring);
    if (ret < 0) {
        fprintf(stderr, "io_uring_submit: %s\n", strerror(-ret));
        goto out_close;
    }
    if (ret != 1) {
        fprintf(stderr, "io_uring_submit: submitted %d requests, expected 1\n", ret);
        goto out_close;
    }

    ret = io_uring_wait_cqe(&ring, &cqe);
    if (ret < 0) {
        fprintf(stderr, "io_uring_wait_cqe: %s\n", strerror(-ret));
        goto out_close;
    }

    if (io_uring_cqe_get_data64(cqe) != 42) {
        fprintf(stderr, "unexpected completion identifier\n");
        io_uring_cqe_seen(&ring, cqe);
        goto out_close;
    }

    ret = cqe->res;
    io_uring_cqe_seen(&ring, cqe);

    if (ret < 0) {
        fprintf(stderr, "read: %s\n", strerror(-ret));
        goto out_close;
    }

    buffer[ret] = '\0';
    printf("read %d bytes: %s\n", ret, buffer);
    status = EXIT_SUCCESS;

out_close:
    if (close(fd) < 0) {
        perror("close");
        status = EXIT_FAILURE;
    }
out_ring:
    io_uring_queue_exit(&ring);
    return status;
}
