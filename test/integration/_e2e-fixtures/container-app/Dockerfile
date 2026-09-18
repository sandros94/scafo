# The container class's image: busybox's own HTTP server and nothing else, so
# the node that accepts the deploy builds it in seconds and the tar it saves to
# the bucket stays small.
FROM busybox:1.37
RUN mkdir -p /www && echo '{"ok":true}' > /www/index.html
EXPOSE 8080
CMD ["httpd", "-f", "-p", "8080", "-h", "/www"]
