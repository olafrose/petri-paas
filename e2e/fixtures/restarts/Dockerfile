FROM busybox:1.37
RUN mkdir /www && echo "<h1>Hello again</h1>" > /www/index.html
EXPOSE 8080
# Exits once, 20 seconds in, as an app does when it crashes or its host
# goes down; Docker starts it again. The second time it keeps running.
CMD ["sh", "-c", "echo restarts app started; httpd -p 8080 -h /www; if [ -e /tmp/restarted ]; then exec sleep 2147483647; fi; touch /tmp/restarted; sleep 20; echo restarts app exiting; exit 1"]
