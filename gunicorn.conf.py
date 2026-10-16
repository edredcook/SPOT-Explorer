"""Keep authentication callback codes and referrers out of request logs."""

# Gunicorn loads this file from the application directory. %(U)s is the path
# without the query string; %(r)s and the Referer header can contain reset codes.
access_log_format = '%(h)s %(t)s "%(m)s %(U)s %(H)s" %(s)s %(b)s'
