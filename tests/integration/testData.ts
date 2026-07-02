import type { ExasolDriver } from '@exasol/exasol-driver-ts';

/**
 * Creates the full set of schema objects used by Schema Explorer integration
 * tests: three tables (with FK constraints and sample rows), two views, two
 * SQL scalar functions, and two Python3 UDF scripts.
 *
 * Mirrors the `db_tables`, `db_views`, `db_functions`, and `db_scripts`
 * fixtures in the MCP Server integration test conftest.py, translated to
 * Exasol SQL via the TypeScript driver.
 *
 * @param driver - an already-connected ExasolDriver instance
 * @param schema - the schema in which to create all objects (must already exist)
 */
export async function setupTestData(driver: ExasolDriver, schema: string): Promise<void> {
	await createTables(driver, schema);
	await insertRows(driver, schema);
	await createViews(driver, schema);
	await createFunctions(driver, schema);
	await createScripts(driver, schema);
}

async function createTables(driver: ExasolDriver, schema: string): Promise<void> {
	// Primary table: one ski resort per row.
	await driver.execute(`
		CREATE TABLE ${schema}.SKI_RESORT (
			RESORT_ID   DECIMAL(18,0),
			RESORT_NAME VARCHAR(1000) UTF8,
			COUNTRY     VARCHAR(100) UTF8,
			ALTITUDE    DECIMAL(18,0),
			CONSTRAINT SKI_RESORT_PK PRIMARY KEY (RESORT_ID)
		)
	`);
	await driver.execute(
		`COMMENT ON TABLE ${schema}.SKI_RESORT IS 'the table contains basic information about ski resorts'`,
	);
	await driver.execute(
		`COMMENT ON COLUMN ${schema}.SKI_RESORT.RESORT_ID IS 'the ski resort id'`,
	);
	await driver.execute(
		`COMMENT ON COLUMN ${schema}.SKI_RESORT.ALTITUDE IS 'the ski resort altitude above the see level in meters'`,
	);

	// Child table: multiple runs per resort, FK back to SKI_RESORT.
	await driver.execute(`
		CREATE TABLE ${schema}.SKI_RUN (
			RESORT_ID  DECIMAL(18,0),
			RUN_NAME   VARCHAR(200) UTF8,
			DIFFICULTY VARCHAR(10) UTF8,
			LENGTH     DECIMAL(18,0),
			CONSTRAINT SKI_RUN_PK  PRIMARY KEY (RESORT_ID, RUN_NAME),
			CONSTRAINT RESORT_FK   FOREIGN KEY (RESORT_ID)
				REFERENCES ${schema}.SKI_RESORT (RESORT_ID)
		)
	`);
	await driver.execute(
		`COMMENT ON TABLE ${schema}.SKI_RUN IS 'the table contains detailed information about ski runs in different resorts'`,
	);
	await driver.execute(
		`COMMENT ON COLUMN ${schema}.SKI_RUN.RESORT_ID IS 'the ski resort id'`,
	);
	await driver.execute(
		`COMMENT ON COLUMN ${schema}.SKI_RUN.DIFFICULTY IS 'the run difficulty level - green, blue, red, black'`,
	);
	await driver.execute(
		`COMMENT ON COLUMN ${schema}.SKI_RUN.LENGTH IS 'the run length in meters'`,
	);

	// Junction table: competitions held at a specific run; starts with no rows.
	await driver.execute(`
		CREATE TABLE ${schema}.COMPETITIONS (
			SERIES          VARCHAR(500) UTF8,
			YEAR            DECIMAL(18,0),
			RESORT_ID       DECIMAL(18,0),
			COMPETITION_RUN VARCHAR(200) UTF8,
			CONSTRAINT COMPETITION_FK FOREIGN KEY (RESORT_ID, COMPETITION_RUN)
				REFERENCES ${schema}.SKI_RUN (RESORT_ID, RUN_NAME)
		)
	`);
	await driver.execute(
		`COMMENT ON TABLE ${schema}.COMPETITIONS IS 'information about competitions in different resorts'`,
	);
}

async function insertRows(driver: ExasolDriver, schema: string): Promise<void> {
	await driver.execute(`
		INSERT INTO ${schema}.SKI_RESORT VALUES
			(1000, 'Val Thorens', 'France', 2300),
			(1001, 'Courchevel', 'France', 1850),
			(1002, 'Kitzbuhel', 'Austria', 762)
	`);

	await driver.execute(`
		INSERT INTO ${schema}.SKI_RUN VALUES
			(1000, 'Christine',            'Blue',  1200),
			(1000, 'Allamande',            'Red',    950),
			(1001, 'Combe de la Saulire',  'Red',   1550),
			(1001, 'Chanrossa',            'Black',  800),
			(1002, 'Hochsaukaser',         'Red',   1900),
			(1002, 'Steilhang',            'Black', 1200),
			(1002, 'Sonnenrast',           'Green',  200)
	`);
}

async function createViews(driver: ExasolDriver, schema: string): Promise<void> {
	await driver.execute(`
		CREATE VIEW ${schema}.HIGH_ALTITUDE_RESORT AS
			SELECT * FROM ${schema}.SKI_RESORT WHERE ALTITUDE > 2000
	`);
	await driver.execute(
		`COMMENT ON VIEW ${schema}.HIGH_ALTITUDE_RESORT IS 'ski resorts situated at the altitude higher than 2000 meters'`,
	);

	await driver.execute(`
		CREATE VIEW ${schema}.DIFFICULT_RUN AS
			SELECT * FROM ${schema}.SKI_RUN WHERE UPPER(DIFFICULTY) = 'BLACK'
	`);
	await driver.execute(
		`COMMENT ON VIEW ${schema}.DIFFICULT_RUN IS 'the view lists all known black runs'`,
	);
}

async function createFunctions(driver: ExasolDriver, schema: string): Promise<void> {
	// Exasol PL/SQL scalar function: removes characters between two positions.
	// The trailing slash is the statement terminator required by the Exasol SQL API.
	await driver.execute(`
		CREATE OR REPLACE FUNCTION ${schema}.CUT_MIDDLE(
				INP_TEXT VARCHAR(1000), CUT_FROM DECIMAL(18,0), CUT_TO DECIMAL(18,0))
		RETURN VARCHAR(1000)
		IS
			LEN INTEGER;
			RES VARCHAR(1000);
		BEGIN
			LEN := LENGTH(INP_TEXT);
			IF CUT_FROM <= 0 OR CUT_TO <= CUT_FROM OR LEN < CUT_FROM THEN
				RES := INP_TEXT;
			ELSE
				RES := LEFT(INP_TEXT, CUT_FROM) || RIGHT(INP_TEXT, LEN - CUT_TO + 1);
			END IF;
			RETURN RES;
		END;
		/
	`);
	await driver.execute(
		`COMMENT ON FUNCTION ${schema}.CUT_MIDDLE IS 'cuts a middle of the provided text'`,
	);

	// Exasol PL/SQL scalar function: iterative factorial.
	await driver.execute(`
		CREATE OR REPLACE FUNCTION ${schema}.FACTORIAL(NUM DECIMAL(18,0))
		RETURN DECIMAL(18,0)
		IS
			RES INTEGER;
		BEGIN
			RES := 1;
			FOR I := 1 TO NUM DO
				RES := RES * I;
			END FOR;
			RETURN RES;
		END;
		/
	`);
	await driver.execute(
		`COMMENT ON FUNCTION ${schema}.FACTORIAL IS 'computes the factorial of a number'`,
	);
}

async function createScripts(driver: ExasolDriver, schema: string): Promise<void> {
	// Python3 SCALAR UDF: emits the first N numbers of the Fibonacci sequence.
	// SCALAR scripts are called once per input row; EMITS means it can produce
	// multiple output rows (here: one per sequence position).
	await driver.execute(`
		CREATE OR REPLACE PYTHON3 SCALAR SCRIPT ${schema}.FIBONACCI(
				SEQ_LENGTH DECIMAL(18,0))
		EMITS (NUM DECIMAL(18,0), VAL DECIMAL(18,0))
		AS
		def run(ctx):
		    last_two = [0, 1]
		    next_id = 0
		    for i in range(int(ctx.SEQ_LENGTH)):
		        if i >= 2:
		            last_two[next_id] = sum(last_two)
		        ctx.emit(i, last_two[next_id])
		        next_id = (next_id + 1) % 2
		/
	`);
	await driver.execute(
		`COMMENT ON SCRIPT ${schema}.FIBONACCI IS 'emits Fibonacci sequence of the given length'`,
	);

	// Python3 SET UDF: aggregates weighted text lengths across a group of rows.
	// SET scripts receive all rows of a group; ctx.next() advances to the next row.
	await driver.execute(`
		CREATE OR REPLACE PYTHON3 SET SCRIPT ${schema}.WEIGHTED_LENGTH(
				TEXT VARCHAR(100000) UTF8, WEIGHT DOUBLE)
		RETURNS DOUBLE
		AS
		def run(ctx):
		    more_data = True
		    result = 0.0
		    while more_data:
		        result += len(ctx.TEXT) * ctx.WEIGHT
		        more_data = ctx.next()
		    return result
		/
	`);
	await driver.execute(
		`COMMENT ON SCRIPT ${schema}.WEIGHTED_LENGTH IS 'computes weighted sum of the input text lengths'`,
	);
}
