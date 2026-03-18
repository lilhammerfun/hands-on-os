// echo_select.c — select-based single-threaded echo server
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <sys/select.h>

int main() {
    int server_fd = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_port = htons(9000),
        .sin_addr.s_addr = INADDR_ANY
    };
    bind(server_fd, (struct sockaddr *)&addr, sizeof(addr));
    listen(server_fd, 128);

    fd_set all_fds, read_fds;
    FD_ZERO(&all_fds);
    FD_SET(server_fd, &all_fds);
    int max_fd = server_fd;

    while (1) {
        read_fds = all_fds;   // select 会修改 fd_set，每次必须重新复制
        select(max_fd + 1, &read_fds, NULL, NULL, NULL);

        for (int fd = 0; fd <= max_fd; fd++) {
            if (!FD_ISSET(fd, &read_fds))
                continue;
            if (fd == server_fd) {
                int client_fd = accept(server_fd, NULL, NULL);
                FD_SET(client_fd, &all_fds);
                if (client_fd > max_fd) max_fd = client_fd;
            } else {
                char buf[1024];
                ssize_t n = read(fd, buf, sizeof(buf));
                if (n <= 0) {
                    close(fd);
                    FD_CLR(fd, &all_fds);
                } else {
                    write(fd, buf, n);
                }
            }
        }
    }
}
