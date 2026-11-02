// Approved D-01 / D-02 / D-03 and D-04 final Boundary DDL, unchanged.
export const LIFECYCLE_DDL = String.raw`CREATE TABLE backend_lifecycle (
    lifecycle_key INTEGER PRIMARY KEY NOT NULL
        CHECK (lifecycle_key = 1),
    state TEXT NOT NULL
        CHECK (state IN ('RUNNING', 'CLEAN')),
    boot_id TEXT NOT NULL
        CHECK (length(boot_id) > 0),
    generation INTEGER NOT NULL
        CHECK (
            typeof(generation) = 'integer'
            AND generation >= 1
            AND generation <= 9007199254740991
        )
);

CREATE TABLE startup_generations (
    generation INTEGER PRIMARY KEY NOT NULL
        CHECK (
            generation >= 2
            AND generation <= 9007199254740991
        ),
    boot_id TEXT NOT NULL
        CHECK (length(boot_id) > 0),
    previous_state TEXT NOT NULL
        CHECK (previous_state IN ('RUNNING', 'CLEAN')),
    previous_boot_id TEXT NOT NULL
        CHECK (length(previous_boot_id) > 0),
    previous_generation INTEGER NOT NULL
        CHECK (
            typeof(previous_generation) = 'integer'
            AND previous_generation >= 1
            AND previous_generation <= 9007199254740990
        ),
    CHECK (generation = previous_generation + 1)
);

CREATE TABLE startup_provider_boundaries (
    generation INTEGER NOT NULL
        CHECK (typeof(generation) = 'integer'),
    provider_key TEXT NOT NULL
        CHECK (length(provider_key) > 0),
    provider_state TEXT NOT NULL
        CHECK (
            provider_state IN ('UNPROVISIONED', 'PROVISIONED')
        ),
    cutoff_sequence INTEGER,
    history_status_snapshot TEXT,
    initialized_at_ms_snapshot INTEGER,
    history_fingerprint TEXT NOT NULL
        CHECK (
            length(history_fingerprint) = 64
            AND history_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
    PRIMARY KEY (generation, provider_key),
    FOREIGN KEY (generation)
        REFERENCES startup_generations(generation),
    CHECK (
        (
            provider_state = 'UNPROVISIONED'
            AND cutoff_sequence IS NULL
        )
        OR
        (
            provider_state = 'PROVISIONED'
            AND cutoff_sequence IS NOT NULL
            AND typeof(cutoff_sequence) = 'integer'
            AND cutoff_sequence >= 0
            AND cutoff_sequence <= 9007199254740991
        )
    ),
    CHECK (
        (
            provider_state = 'UNPROVISIONED'
            AND history_status_snapshot IS NULL
            AND initialized_at_ms_snapshot IS NULL
        )
        OR
        (
            provider_state = 'PROVISIONED'
            AND history_status_snapshot IS NOT NULL
            AND history_status_snapshot IN ('ACTIVE', 'SUSPENDED')
            AND initialized_at_ms_snapshot IS NOT NULL
            AND typeof(initialized_at_ms_snapshot) = 'integer'
            AND initialized_at_ms_snapshot >= 0
            AND initialized_at_ms_snapshot <= 9007199254740991
        )
    )
);

CREATE TABLE history_uncertain_ranges (
    provider_key TEXT NOT NULL
        CHECK (length(provider_key) > 0),
    generation INTEGER NOT NULL
        CHECK (typeof(generation) = 'integer'),
    range_id INTEGER NOT NULL
        CHECK (
            typeof(range_id) = 'integer'
            AND range_id >= 1
            AND range_id <= 9007199254740991
        ),
    start_sequence INTEGER NOT NULL
        CHECK (
            typeof(start_sequence) = 'integer'
            AND start_sequence >= 1
            AND start_sequence <= 9007199254740991
        ),
    end_sequence INTEGER NOT NULL
        CHECK (
            typeof(end_sequence) = 'integer'
            AND end_sequence >= start_sequence
            AND end_sequence <= 9007199254740991
        ),
    PRIMARY KEY (provider_key, generation, range_id),
    FOREIGN KEY (generation, provider_key)
        REFERENCES startup_provider_boundaries(
            generation, provider_key
        )
);`;
