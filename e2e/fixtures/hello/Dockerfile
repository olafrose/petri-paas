FROM busybox:1.37
RUN mkdir /www && echo "<h1>Hello from an end-to-end test</h1>" > /www/index.html
EXPOSE 8080
CMD ["httpd", "-f", "-p", "8080", "-h", "/www"]
