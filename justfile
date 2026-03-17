# Start an x86-64 Linux shell with gcc/binutils, project mounted at /work
linux:
    docker run -it --rm --platform linux/amd64 -v {{ justfile_directory() }}:/work -w /work gcc:14 bash
