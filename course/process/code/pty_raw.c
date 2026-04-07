#define _XOPEN_SOURCE 600
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

static void show_flags(const char *label, int slave_fd) {
    struct termios t;
    tcgetattr(slave_fd, &t);
    printf("%s  ICANON=%d  ECHO=%d  ISIG=%d  ICRNL=%d\n", label,
           !!(t.c_lflag & ICANON), !!(t.c_lflag & ECHO),
           !!(t.c_lflag & ISIG),   !!(t.c_iflag & ICRNL));
}

int main(void) {
    int master_fd = posix_openpt(O_RDWR | O_NOCTTY);
    grantpt(master_fd);
    unlockpt(master_fd);
    int slave_fd = open(ptsname(master_fd), O_RDWR);

    /* default: cooked mode */
    show_flags("cooked:", slave_fd);

    /* switch to raw mode */
    struct termios raw;
    tcgetattr(slave_fd, &raw);
    raw.c_lflag &= ~(ICANON | ECHO | ISIG);
    raw.c_iflag &= ~(ICRNL | IXON);
    tcsetattr(slave_fd, TCSANOW, &raw);

    show_flags("raw:   ", slave_fd);
    fflush(stdout);

    /* demonstrate: in raw mode, Ctrl+C (0x03) passes through as data */
    pid_t pid = fork();
    if (pid == 0) {
        char buf[16] = {0};
        int n = read(slave_fd, buf, sizeof(buf));
        printf("raw mode: child read byte 0x%02x", (unsigned char)buf[0]);
        if (buf[0] == 0x03)
            printf(" (Ctrl+C passed through as data, no SIGINT)\n");
        else
            printf("\n");
        fflush(stdout);
        close(slave_fd);
        close(master_fd);
        _exit(0);
    }
    usleep(50000);
    char ctrl_c = 0x03;
    write(master_fd, &ctrl_c, 1);
    waitpid(pid, NULL, 0);

    close(slave_fd);
    close(master_fd);
    return 0;
}
