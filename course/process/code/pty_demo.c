#define _XOPEN_SOURCE 600
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

int main(void) {
    /* create PTY pair */
    int master_fd = posix_openpt(O_RDWR | O_NOCTTY);
    grantpt(master_fd);
    unlockpt(master_fd);
    char *slave_name = ptsname(master_fd);
    printf("slave device: %s\n", slave_name);
    fflush(stdout);

    pid_t pid = fork();
    if (pid == 0) {
        /* child: close master, open slave */
        close(master_fd);
        int slave_fd = open(slave_name, O_RDWR);

        /* read what parent wrote via master */
        char buf[64] = {0};
        int n = read(slave_fd, buf, sizeof(buf) - 1);
        /* strip trailing \r\n added by line discipline */
        while (n > 0 && (buf[n-1] == '\n' || buf[n-1] == '\r')) n--;
        buf[n] = '\0';
        printf("child read from slave: \"%s\"\n", buf);
        fflush(stdout);

        /* write back via slave */
        write(slave_fd, "hello from slave\n", 17);
        close(slave_fd);
        _exit(0);
    }

    /* parent: write to master → data reaches slave */
    usleep(50000);
    write(master_fd, "hello from master\n", 18);

    /* parent: read from master ← data written by child to slave */
    usleep(50000);
    char buf[256] = {0};
    int n = read(master_fd, buf, sizeof(buf) - 1);
    /* find the "hello from slave" part (skip echoed input) */
    char *p = strstr(buf, "hello from slave");
    if (p) printf("parent read from master: \"%.*s\"\n", 16, p);

    waitpid(pid, NULL, 0);
    close(master_fd);
    return 0;
}
