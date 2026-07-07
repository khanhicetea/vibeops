#!/usr/bin/env bash
set -euo pipefail

cat >&2 <<'MSG'
This stack has the official NGINX ACME module enabled, but generated vhosts
start with the default self-signed certificate so nginx can boot before DNS is ready.

To enable real ACME for a generated vhost:

  ./scripts/acme.sh <domain>

If you need to use externally managed certificate files instead:

  ./scripts/use-cert.sh <domain>
MSG
exit 1
