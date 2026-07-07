#!/usr/bin/env sh
set -eu

php-user-sync

# Official PHP image entrypoint still handles extension ini generation and command normalization.
exec docker-php-entrypoint "$@"
