"""Entry point for the installed broker zipapp."""
import asyncio
import sys

from . import core

if sys.argv[1:] == ["--cleanup-firewall"]:
    core._cleanup_firewall()
elif sys.argv[1:]:
    raise SystemExit("unsupported broker arguments")
else:
    asyncio.run(core.main())
