FROM gcc:14

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        procps \
        strace \
        util-linux \
    && rm -rf /var/lib/apt/lists/*
