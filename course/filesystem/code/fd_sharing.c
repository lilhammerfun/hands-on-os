#include <fcntl.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

int main(void) {
    /* prepare a test file */
    int fd = open("/tmp/test_fd.txt", O_RDWR | O_CREAT | O_TRUNC, 0644);
    write(fd, "hello, world!\n", 14);
    lseek(fd, 0, SEEK_SET);

    /* fork: parent and child share the same open file description */
    pid_t pid = fork();
    if (pid == 0) {
        char buf[6] = {0};
        read(fd, buf, 5);
        printf("[fork]  child read: \"%s\"\n", buf);
        fflush(stdout);
        close(fd);
        _exit(0);
    }
    waitpid(pid, NULL, 0);
    printf("[fork]  parent offset after child read: %lld\n",
           (long long)lseek(fd, 0, SEEK_CUR));
    close(fd);

    /* two independent open() calls: separate open file descriptions */
    int fd1 = open("/tmp/test_fd.txt", O_RDONLY);
    int fd2 = open("/tmp/test_fd.txt", O_RDONLY);
    char buf[6] = {0};
    read(fd1, buf, 5);
    printf("[open]  fd1 read: \"%s\"\n", buf);
    printf("[open]  fd1 offset: %lld, fd2 offset: %lld\n",
           (long long)lseek(fd1, 0, SEEK_CUR),
           (long long)lseek(fd2, 0, SEEK_CUR));

    close(fd1);
    close(fd2);
    unlink("/tmp/test_fd.txt");
    return 0;
}
