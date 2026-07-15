FROM biarms/mysql:5.7

USER root
RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends bash gzip zstd; \
    rm -rf /var/lib/apt/lists/*

# The legacy biarms entrypoint fixes ownership of the data directory before
# dropping privileges, but not the bind-mounted log directory used by bento.
COPY biarms-entrypoint.sh /usr/local/bin/bento-biarms-entrypoint.sh
RUN chmod 0755 /usr/local/bin/bento-biarms-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/bento-biarms-entrypoint.sh"]
CMD ["mysqld"]
