import signal
import sys
from partitura_broker import cli

def interrupted(_signal, _frame):
    raise InterruptedError('native job interrupted')

for number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(number, interrupted)
sys.exit(cli(sys.argv[1:]))
