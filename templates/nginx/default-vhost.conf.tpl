# Reject requests whose Host/SNI does not match a configured site.
server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name _;

  return 404;
}

server {
  listen 443 ssl default_server;
  listen [::]:443 ssl default_server;
  {{#http3}}
  listen 443 quic default_server;
  listen [::]:443 quic default_server;
  {{/http3}}
  http2 on;
  server_name _;

  include /etc/nginx/snippets/boot-ssl.conf;

  return 404;
}
