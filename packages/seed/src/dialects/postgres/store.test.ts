import { drizzle as drizzleJs } from "drizzle-orm/postgres-js";
import { describe, expect, test } from "vitest";
import { postgres } from "#test";
import {
  type DrizzleORMPgClient,
  createDrizzleORMPgClient,
} from "./adapters.js";
import { getDatamodel } from "./dataModel.js";
import { PgStore } from "./store.js";

const adapters = {
  postgresJs: () => ({
    ...postgres.postgresJs,
    drizzle: drizzleJs,
  }),
};

async function execQueries(client: DrizzleORMPgClient, queries: Array<string>) {
  for (const query of queries) {
    await client.run(query);
  }
}

describe.each(["postgresJs"] as const)("store: %s", (adapter) => {
  const { drizzle, createTestDb } = adapters[adapter]();
  describe("SQL -> Store -> SQL", () => {
    test("should be able to insert basic rows into table", async () => {
      const structure = `
      CREATE TABLE "test_customer" (
        id SERIAL PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL
      );
      `;
      const db = await createTestDb(structure);
      const orm = createDrizzleORMPgClient(drizzle(db.client));
      const dataModel = await getDatamodel(orm);

      const store = new PgStore(dataModel);

      store.add("test_customer", {
        id: "2",
        name: "Cadavre Exquis",
        email: "cadavre@ex.quis",
      });

      store.add("test_customer", {
        id: "3",
        name: "Winrar Skarsgård",
        email: "win@rar.gard",
      });
      await execQueries(orm, [...store.toSQL()]);
      const results = await orm.query(`SELECT * FROM test_customer`);
      expect(results).toEqual(
        expect.arrayContaining([
          { id: 2, name: "Cadavre Exquis", email: "cadavre@ex.quis" },
          { id: 3, name: "Winrar Skarsgård", email: "win@rar.gard" },
        ]),
      );
    });
    test("should insert into columns with default value set", async () => {
      const structure = `
      CREATE TABLE "test_customer" (
        id SERIAL PRIMARY KEY NOT NULL,
        name TEXT DEFAULT 'default_name' NOT NULL,
        email TEXT NOT NULL
      );
    `;
      const db = await createTestDb(structure);
      const orm = createDrizzleORMPgClient(drizzle(db.client));
      const dataModel = await getDatamodel(orm);

      const store = new PgStore(dataModel);

      store.add("test_customer", {
        email: "cadavre@ex.quis",
      });

      store.add("test_customer", {
        name: "Winrar Skarsgård",
        email: "win@rar.gard",
      });
      await execQueries(orm, [...store.toSQL()]);
      const results = await orm.query(
        `SELECT * FROM test_customer ORDER BY id ASC`,
      );
      expect(results).toEqual(
        expect.arrayContaining([
          { id: 1, name: "default_name", email: "cadavre@ex.quis" },
          { id: 2, name: "Winrar Skarsgård", email: "win@rar.gard" },
        ]),
      );
    });
    test("should insert into columns with generated column values", async () => {
      const structure = `
      CREATE TABLE "test_customer" (
        id SERIAL PRIMARY KEY NOT NULL,
        name TEXT DEFAULT 'default_name' NOT NULL,
        email TEXT NOT NULL,
        full_details TEXT GENERATED ALWAYS AS (name || ' <' || email || '>') STORED
      );
    `;
      const db = await createTestDb(structure);
      const orm = createDrizzleORMPgClient(drizzle(db.client));
      const dataModel = await getDatamodel(orm);

      const store = new PgStore(dataModel);

      // For PostgreSQL, no need to explicitly set the ID for SERIAL columns in typical use cases
      store.add("test_customer", {
        email: "cadavre@ex.quis",
      });

      store.add("test_customer", {
        name: "Winrar Skarsgård",
        email: "win@rar.gard",
      });

      await execQueries(orm, [...store.toSQL()]);
      const results = await orm.query(
        `SELECT * FROM test_customer ORDER BY id ASC`,
      );

      // Expect the generated full_details column to concatenate name and email as specified
      expect(results).toEqual(
        expect.arrayContaining([
          {
            id: 1, // Adjusted ID since SERIAL automatically increments
            name: "default_name",
            email: "cadavre@ex.quis",
            full_details: "default_name <cadavre@ex.quis>",
          },
          {
            id: 2, // Adjusted ID since SERIAL automatically increments
            name: "Winrar Skarsgård",
            email: "win@rar.gard",
            full_details: "Winrar Skarsgård <win@rar.gard>",
          },
        ]),
      );
    });
    test("should handle nullable column values correctly", async () => {
      const structure = `
      CREATE TABLE "test_customer" (
        id SERIAL PRIMARY KEY NOT NULL,
        name TEXT DEFAULT 'default_name' NOT NULL,
        email TEXT NOT NULL,
        phone TEXT,
        full_details TEXT GENERATED ALWAYS AS (name || ' <' || email || '>' || ' Phone: ' || COALESCE(phone, 'N/A')) STORED
      );
    `;
      const db = await createTestDb(structure);
      const orm = createDrizzleORMPgClient(drizzle(db.client));
      const dataModel = await getDatamodel(orm);

      const store = new PgStore(dataModel);

      store.add("test_customer", {
        email: "unknown@no.phone",
      });

      store.add("test_customer", {
        name: "Phoney McPhoneface",
        email: "phoney@mc.phone",
        phone: "+1234567890",
      });

      await execQueries(orm, [...store.toSQL()]);
      const results = await orm.query(
        `SELECT * FROM test_customer ORDER BY id ASC`,
      );

      expect(results).toEqual(
        expect.arrayContaining([
          {
            id: 1, // Adjusted ID for SERIAL
            name: "default_name",
            email: "unknown@no.phone",
            phone: null,
            full_details: "default_name <unknown@no.phone> Phone: N/A",
          },
          {
            id: 2, // Adjusted ID for SERIAL
            name: "Phoney McPhoneface",
            email: "phoney@mc.phone",
            phone: "+1234567890",
            full_details:
              "Phoney McPhoneface <phoney@mc.phone> Phone: +1234567890",
          },
        ]),
      );
    });
    test("should handle relational data with nullable column values correctly in PostgreSQL", async () => {
      const structure = `
        CREATE TABLE test_customer (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT UNIQUE NOT NULL
        );

        CREATE TABLE test_order (
          id SERIAL PRIMARY KEY,
          customer_id INTEGER NOT NULL,
          product_name TEXT NOT NULL,
          quantity INTEGER DEFAULT 1 NOT NULL,
          FOREIGN KEY (customer_id) REFERENCES test_customer(id)
        );
      `;

      const db = await createTestDb(structure);
      const orm = createDrizzleORMPgClient(drizzle(db.client));
      const dataModel = await getDatamodel(orm);

      const store = new PgStore(dataModel);

      store.add("test_customer", {
        name: "John Doe",
        email: "john@doe.email",
      });
      store.add("test_customer", {
        name: "Jane Doe",
        email: "jane@doe.email",
      });

      const johnDoeId = 1;
      const janeDoeId = 2;

      store.add("test_order", {
        customer_id: johnDoeId,
        product_name: "Widget",
        quantity: 3,
      });
      store.add("test_order", {
        customer_id: janeDoeId,
        product_name: "Gadget",
      });

      await execQueries(orm, [...store.toSQL()]);
      const results = await orm.query(
        `SELECT test_customer.name, test_order.quantity FROM test_order JOIN test_customer ON test_customer.id = test_order.customer_id ORDER BY test_order.id ASC`,
      );

      expect(results).toEqual(
        expect.arrayContaining([
          {
            name: "John Doe",
            quantity: 3,
          },
          {
            name: "Jane Doe",
            quantity: 1,
          },
        ]),
      );
    });
    test("should handle auto circular references", async () => {
      const structure = `
        create table customer (
          id serial primary key,
          name text not null,
          referrer_id integer references customer(id)
        );
      `;

      const db = await createTestDb(structure);
      const orm = createDrizzleORMPgClient(drizzle(db.client));
      const dataModel = await getDatamodel(orm);

      const store = new PgStore(dataModel);

      store.add("customer", {
        id: 1,
        name: "John Doe",
        referrer_id: 2,
      });

      store.add("customer", {
        id: 2,
        name: "Jane Doe",
        referrer_id: 1,
      });

      await execQueries(orm, [...store.toSQL()]);
      const results = await orm.query(`select * from customer order by id asc`);

      expect(results).toEqual(
        expect.arrayContaining([
          {
            id: 1,
            name: "John Doe",
            referrer_id: 2,
          },
          {
            id: 2,
            name: "Jane Doe",
            referrer_id: 1,
          },
        ]),
      );
    });
    test("should handle complex circular references", async () => {
      const structure = `
        create table customer (
          id serial primary key,
          name text not null,
          last_order_id integer
        );

        create table product (
          id serial primary key,
          name text not null,
          first_order_id integer
        );

        create table "order" (
          id serial primary key,
          customer_id integer not null,
          product_id integer not null,
          quantity integer not null,
          CONSTRAINT fk_customer
            FOREIGN KEY(customer_id)
            REFERENCES customer(id),
          CONSTRAINT fk_product
            FOREIGN KEY(product_id)
            REFERENCES product(id)
        );
        -- Add constraints to customer and product tables
        alter table customer add constraint fk_last_order
          foreign key (last_order_id) references "order"(id);
    
        alter table product add constraint fk_first_order
          foreign key (first_order_id) references "order"(id);
      `;

      const db = await createTestDb(structure);
      const orm = createDrizzleORMPgClient(drizzle(db.client));
      const dataModel = await getDatamodel(orm);

      const store = new PgStore(dataModel);

      // Assume IDs are auto-generated correctly and linked properly
      store.add("product", {
        id: 1,
        name: "Gadget",
        first_order_id: 1, // This will be updated later after creating the order
      });

      store.add("customer", {
        id: 1,
        name: "John Doe",
        last_order_id: 1, // This will be updated later after creating the order
      });

      store.add("order", {
        id: 1,
        customer_id: 1,
        product_id: 1,
        quantity: 10,
      });

      await execQueries(orm, [...store.toSQL()]);

      const customerResults = await orm.query(
        `select * from customer order by id asc`,
      );
      const orderResults = await orm.query(
        `select * from order order by id asc`,
      );
      const productResults = await orm.query(
        `select * from product order by id asc`,
      );

      expect(customerResults).toEqual(
        expect.arrayContaining([
          {
            id: 1,
            name: "John Doe",
            last_order_id: 1,
          },
        ]),
      );

      expect(orderResults).toEqual(
        expect.arrayContaining([
          {
            id: 1,
            customer_id: 1,
            product_id: 1,
            quantity: 10,
          },
        ]),
      );

      expect(productResults).toEqual(
        expect.arrayContaining([
          {
            id: 1,
            name: "Gadget",
            first_order_id: 1,
          },
        ]),
      );
    });
  });
});
