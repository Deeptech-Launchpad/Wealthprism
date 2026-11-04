-- "Collectible or wine" is no longer offered when adding a physical asset. Assets already saved with that kind stay as they are.
delete from asset_types where code = 'collectible';
