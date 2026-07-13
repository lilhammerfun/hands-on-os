# Build the native Linux shell image with gcc/binutils/strace
linux-image:
    docker build -t hands-on-os-linux -f docker/linux-shell.Dockerfile docker

# Start a native Linux shell with gcc/binutils/strace, project mounted at /project
linux: linux-image
    docker run -it --rm --name hands-on-os --hostname hands-on-os -v {{ justfile_directory() }}:/project -w /project hands-on-os-linux bash

# Start an x86-64 shell for architecture-specific ELF and assembly examples
linux-x86:
    docker run -it --rm --platform linux/amd64 --name hands-on-os-x86 --hostname hands-on-os-x86 -v {{ justfile_directory() }}:/project -w /project gcc:14 bash
