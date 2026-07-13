#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

static int write_all(int fd, const char *data, size_t length)
{
    size_t written = 0;

    while (written < length) {
        ssize_t n = write(fd, data + written, length - written);
        if (n > 0) {
            written += (size_t)n;
            continue;
        }
        if (n < 0 && errno == EINTR)
            continue;
        if (n == 0)
            errno = EIO;
        return -1;
    }

    return 0;
}

static int split_path(const char *path, char **directory, const char **name)
{
    const char *slash = strrchr(path, '/');

    if (slash == NULL) {
        *directory = strdup(".");
        *name = path;
    } else if (slash == path) {
        *directory = strdup("/");
        *name = slash + 1;
    } else {
        *directory = strndup(path, (size_t)(slash - path));
        *name = slash + 1;
    }

    if (*directory == NULL)
        return -1;
    if (**name == '\0') {
        errno = EINVAL;
        free(*directory);
        *directory = NULL;
        return -1;
    }

    return 0;
}

int main(int argc, char **argv)
{
    char *directory = NULL;
    const char *target_name;
    char temp_name[NAME_MAX + 1] = {0};
    int directory_fd = -1;
    int temp_fd = -1;
    bool temp_created = false;
    bool renamed = false;
    int status = EXIT_FAILURE;

    if (argc != 3) {
        fprintf(stderr, "usage: %s PATH CONTENT\n", argv[0]);
        return EXIT_FAILURE;
    }

    if (split_path(argv[1], &directory, &target_name) < 0) {
        perror("split path");
        goto out;
    }

    directory_fd = open(directory, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (directory_fd < 0) {
        perror("open parent directory");
        goto out;
    }

    for (unsigned int attempt = 0; attempt < 100; attempt++) {
        int length = snprintf(temp_name, sizeof(temp_name),
                              ".replace.tmp.%ld.%u", (long)getpid(), attempt);
        if (length < 0 || (size_t)length >= sizeof(temp_name)) {
            errno = ENAMETOOLONG;
            perror("create temporary name");
            goto out;
        }

        temp_fd = openat(directory_fd, temp_name,
                         O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0644);
        if (temp_fd >= 0) {
            temp_created = true;
            break;
        }
        if (errno != EEXIST) {
            perror("open temporary file");
            goto out;
        }
    }

    if (temp_fd < 0) {
        errno = EEXIST;
        perror("create unique temporary file");
        goto out;
    }

    if (write_all(temp_fd, argv[2], strlen(argv[2])) < 0) {
        perror("write temporary file");
        goto out;
    }
    if (fsync(temp_fd) < 0) {
        perror("fsync temporary file");
        goto out;
    }
    if (close(temp_fd) < 0) {
        temp_fd = -1;
        perror("close temporary file");
        goto out;
    }
    temp_fd = -1;

    if (renameat(directory_fd, temp_name, directory_fd, target_name) < 0) {
        perror("rename temporary file");
        goto out;
    }
    renamed = true;

    if (fsync(directory_fd) < 0) {
        perror("fsync parent directory");
        goto out;
    }

    printf("replaced %s durably\n", argv[1]);
    status = EXIT_SUCCESS;

out:
    if (temp_fd >= 0)
        close(temp_fd);
    if (temp_created && !renamed && directory_fd >= 0)
        unlinkat(directory_fd, temp_name, 0);
    if (directory_fd >= 0)
        close(directory_fd);
    free(directory);
    return status;
}
