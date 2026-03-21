# Build the x86-64 Linux shell image with gcc/binutils/strace
linux-image:
    docker build -t hands-on-os-linux -f docker/linux-shell.Dockerfile docker

# Start an x86-64 Linux shell with gcc/binutils, project mounted at /project
linux:
    docker run -it --rm --platform linux/amd64 --name hands-on-os --hostname hands-on-os -v {{ justfile_directory() }}:/project -w /project gcc:14 bash
