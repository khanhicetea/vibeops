FROM biarms/mysql:5.7

# The legacy biarms entrypoint fixes ownership of the data directory before
# dropping privileges, but not the bind-mounted log directory used by bento.
# Keep the vendor entrypoint in place and wrap it with the compatibility fix.
COPY biarms-entrypoint.sh /usr/local/bin/bento-biarms-entrypoint.sh

RUN chmod 0755 /usr/local/bin/bento-biarms-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/bento-biarms-entrypoint.sh"]
CMD ["mysqld"]
