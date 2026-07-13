# Aurora Deck — Product Overview

Aurora Deck is Launchpad Labs' collaborative presentation tool for engineering teams.

## Key facts
- Initial release: March 2024 (version 1.0 "Borealis")
- Current version: 3.2 "Zenith", released May 2026
- Maximum slides per deck: 400
- Offline mode: supported since version 2.1 via CRDT sync
- Pricing: Free tier (3 decks), Pro at $14/user/month, Enterprise custom

## Architecture
Aurora Deck renders slides with a WebGPU pipeline codenamed "Prism".
The realtime collaboration backend is built on Elixir/Phoenix channels
and stores operational transforms in FoundationDB.
