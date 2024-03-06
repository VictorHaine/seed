import { format, ident, literal } from "@scaleleap/pg-format";
import { type Json } from "#core/data/types.js";
import { isNullableParent as checkIsNullableParent } from "#core/dataModel/dataModel.js";
import {
  type DataModel,
  type DataModelModel,
  type DataModelScalarField,
} from "#core/dataModel/types.js";
import { groupFields } from "#core/dataModel/utils.js";
import { type ModelData } from "#core/plan/types.js";
import { type Store, StoreBase } from "#core/store/store.js";
import { sortModels } from "#core/store/topologicalSort.js";
import { escapeIdentifier, escapeLiteral, serializeToSQL } from "./utils.js";

interface MissingPKForUpdateError {
  modelName: string;
  type: "missingPKForUpdateError";
}
type ToSQLErrors = MissingPKForUpdateError;

function logToSqlErrors(errors: Array<ToSQLErrors>) {
  if (errors.length === 0) {
    return;
  }
  const missingPKForUpdateErrorsMap = new Map<string, number>();
  for (const error of errors) {
    // Set a unique map per model with the number of affected rows
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (error.type === "missingPKForUpdateError") {
      missingPKForUpdateErrorsMap.set(
        error.modelName,
        (missingPKForUpdateErrorsMap.get(error.modelName) ?? 1) + 1,
      );
    }
  }
  for (const [modelName, affectedRows] of missingPKForUpdateErrorsMap) {
    console.log(
      `Warning: skipping UPDATE on model ${modelName} for ${affectedRows} rows as it has no id fields (no PRIMARY KEYS or UNIQUE NON NULL columns found)`,
    );
  }
}

export class PgStore extends StoreBase {
  toSQL() {
    return createStatements({
      dataModel: this.dataModel,
      store: this._store,
    });

    const SQL_DEFAULT_SYMBOL = "$$DEFAULT$$";

    const sortedModels = sortModels(this.dataModel);
    // we need to maintain an update map to store the ids of nullable parents
    // we will use this map to create the links between the parent and the child once all the models have been inserted
    const insertStatements: Array<string> = [];
    const updateStatements: Array<string> = [];
    const sequenceFixerStatements: Array<string> = [];
    const errorsData: Array<ToSQLErrors> = [];

    for (const entry of sortedModels) {
      const model = entry.node as DataModelModel & { modelName: string };
      const idFieldNames = this.dataModel.models[model.modelName].fields
        .filter((f) => f.kind === "scalar" && f.isId)
        .map((f) => f.name);
      const rows = this._store[model.modelName];

      if (!rows.length) {
        continue;
      }

      const fieldMap = new Map(
        model.fields
          .filter((f) => f.kind === "scalar" && !(f.isGenerated && !f.isId))
          .map((f) => [f.name, f as DataModelScalarField]),
      );
      const fieldToColumnMap = new Map(
        Array.from(fieldMap.values()).map((f) => [f.name, f.columnName]),
      );
      const sequenceFields = model.fields.filter((f) => f.sequence);
      // If we inserted new rows with sequences, we need to update the database sequence value to the max value of the inserted rows
      for (const sequenceField of sequenceFields) {
        const tableName = model.tableName;
        const schemaName = model.schemaName;
        const fieldColumn = fieldToColumnMap.get(sequenceField.name);
        if (
          fieldColumn &&
          sequenceField.sequence &&
          schemaName &&
          tableName &&
          sequenceField.sequence.identifier
        ) {
          const sequenceIdentifier = sequenceField.sequence.identifier;
          const sequenceFixerStatement = `SELECT setval(${escapeLiteral(
            sequenceIdentifier,
          )}::regclass, (SELECT MAX(${escapeIdentifier(
            fieldColumn,
          )}) FROM ${escapeIdentifier(schemaName)}.${escapeIdentifier(
            tableName,
          )}))`;
          sequenceFixerStatements.push(sequenceFixerStatement);
        }
      }
      const insertRowsValues: Array<Array<unknown>> = [];
      for (const row of rows) {
        const insertRowValues: Array<unknown> = [];
        let updateRow:
          | {
              filter: Record<string, unknown>;
              values: Record<string, unknown>;
            }
          | undefined;

        for (const fieldName of fieldMap.keys()) {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          const field = fieldMap.get(fieldName)!;

          const value = row[fieldName];

          if (value === undefined && field.hasDefaultValue) {
            // we use this weird syntax to replace the value in the final sql statements
            insertRowValues.push(SQL_DEFAULT_SYMBOL);
            continue;
          }

          // We check if the column is part of a nullable parent relation
          const isNullableParent = checkIsNullableParent(
            this.dataModel,
            model.modelName,
            fieldName,
          );
          // If it is, and the value is not null, we store the id of the parent in the update map
          if (isNullableParent && value !== null) {
            if (idFieldNames.length > 0) {
              if (!updateRow) {
                updateRow = {
                  filter: idFieldNames.reduce(
                    (acc, idFieldName) => ({
                      ...acc,
                      [idFieldName]: serializeToSQL(
                        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                        fieldMap.get(idFieldName)!.type,
                        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                        row[idFieldName]!,
                      ),
                    }),
                    {},
                  ),
                  values: {},
                };
              }
              updateRow.values[fieldName] = serializeToSQL(
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                fieldMap.get(fieldName)!.type,
                value as Json,
              );
            } else {
              errorsData.push({
                modelName: model.modelName,
                type: "missingPKForUpdateError",
              });
            }
          }
          insertRowValues.push(
            serializeToSQL(
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              fieldMap.get(fieldName)!.type,
              // if the field is a nullable parent, we defer the insert of its parent id for later to avoid fk constraint errors
              isNullableParent ? null : (value as Json),
            ),
          );
        }
        if (updateRow) {
          const updateStatement = [
            `UPDATE ${ident(model.schemaName)}.${ident(model.tableName)}`,
            `SET ${Object.entries(updateRow.values)
              .map(
                ([c, v]) => `${ident(fieldToColumnMap.get(c))} = ${literal(v)}`,
              )
              .join(", ")}`,
            `WHERE ${Object.entries(updateRow.filter)
              .map(
                ([c, v]) => `${ident(fieldToColumnMap.get(c))} = ${literal(v)}`,
              )
              .join(" AND ")}`,
          ].join(" ");
          updateStatements.push(updateStatement);
        }
        insertRowsValues.push(insertRowValues);
      }

      const isGeneratedId =
        model.fields.filter((f) => f.isGenerated && f.isId).length > 0;

      const insertStatementTemplate = [
        "INSERT INTO %I.%I (%I)",
        isGeneratedId ? "OVERRIDING SYSTEM VALUE" : undefined,
        "VALUES %L",
      ]
        .filter((s) => Boolean(s))
        .join(" ");

      const insertStatement = format(
        insertStatementTemplate,
        model.schemaName,
        model.tableName,
        Array.from(fieldToColumnMap.values()),
        insertRowsValues,
      )
        // We patch the "DEFAULT" values as it's a reserved keyword and we don't want to escape it
        .replaceAll(`'${SQL_DEFAULT_SYMBOL}'`, "DEFAULT");
      insertStatements.push(insertStatement);
    }
    logToSqlErrors(errorsData);
    return [
      ...insertStatements,
      ...updateStatements,
      ...sequenceFixerStatements,
    ];
  }
}

function createStatements(ctx: {
  dataModel: DataModel;
  store: Store["_store"];
}) {
  const sequenceFixerStatements: Array<string> = [];
  const inserted: Record<string, Array<ModelData>> = Object.fromEntries(
    Object.keys(ctx.dataModel.models).map(
      (modelName) => [modelName, []] as [string, Array<ModelData>],
    ),
  );
  const pending: Record<string, Array<ModelData>> = Object.fromEntries(
    Object.keys(ctx.dataModel.models).map(
      (modelName) => [modelName, []] as [string, Array<ModelData>],
    ),
  );
  const statements: Array<string> = [];
  const sortedModels = sortModels(ctx.dataModel);
  for (const entry of sortedModels) {
    const model = entry.node as DataModelModel & { modelName: string };
    const rows = ctx.store[model.modelName];
    if (rows.length === 0) {
      continue;
    }
    const fieldMap = new Map(
      model.fields
        .filter((f) => f.kind === "scalar" && !(f.isGenerated && !f.isId))
        .map((f) => [f.name, f as DataModelScalarField]),
    );
    const fieldToColumnMap = new Map(
      Array.from(fieldMap.values()).map((f) => [f.name, f.columnName]),
    );

    const sequenceFields = model.fields.filter((f) => f.sequence);
    // If we inserted new rows with sequences, we need to update the database sequence value to the max value of the inserted rows
    for (const sequenceField of sequenceFields) {
      const tableName = model.tableName;
      const schemaName = model.schemaName;
      const fieldColumn = fieldToColumnMap.get(sequenceField.name);
      if (
        fieldColumn &&
        sequenceField.sequence &&
        schemaName &&
        tableName &&
        sequenceField.sequence.identifier
      ) {
        const sequenceIdentifier = sequenceField.sequence.identifier;
        const sequenceFixerStatement = `SELECT setval(${escapeLiteral(
          sequenceIdentifier,
        )}::regclass, (SELECT MAX(${escapeIdentifier(
          fieldColumn,
        )}) FROM ${escapeIdentifier(schemaName)}.${escapeIdentifier(
          tableName,
        )}))`;
        sequenceFixerStatements.push(sequenceFixerStatement);
      }
    }
    for (const row of rows) {
      createStatement({
        modelName: model.modelName,
        row,
        dataModel: ctx.dataModel,
        inserted: inserted,
        pending: pending,
        statements: statements,
        store: ctx.store,
      });
    }
    console.log(statements);
    return [...statements, ...sequenceFixerStatements];
  }

  function createStatement(ctx: {
    dataModel: DataModel;
    inserted: Record<string, Array<ModelData>>;
    modelName: string;
    pending: Record<string, Array<ModelData>>;
    row: ModelData;
    statements: Array<string>;
    store: Store["_store"];
  }) {
    const model = ctx.dataModel.models[ctx.modelName];

    // get row's id fields
    const rowIdFields = model.fields
      .filter((f) => f.isId)
      .map((f) => [f.name, ctx.row[f.name]]) as Array<[string, ModelData]>;

    // check if the row has already been inserted
    const isRowInserted = ctx.inserted[ctx.modelName].some((r) =>
      rowIdFields.every(([k, v]) => r[k] === v),
    );
    if (isRowInserted) {
      return;
    }

    // mark the row as pending
    ctx.pending[ctx.modelName].push(ctx.row);

    const { scalars, parents } = groupFields(model.fields);

    for (const parent of parents) {
      const parentIdFields = [] as Array<[string, ModelData]>;
      for (const [i] of parent.relationFromFields.entries()) {
        parentIdFields.push([
          parent.relationToFields[i],
          ctx.row[parent.relationFromFields[i]],
        ] as [string, ModelData]);
      }

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (parentIdFields.every(([, v]) => v === null)) {
        continue;
      }

      const parentRow = ctx.store[parent.type].find((r) =>
        parentIdFields.every(([k, v]) => r[k] === v),
      );

      // external data, no need to create a statement
      if (parentRow === undefined) {
        continue;
      }

      // if the row is pending, we have a circular dependency
      if (
        ctx.pending[parent.type].some((r) =>
          parentIdFields.every(([k, v]) => r[k] === v),
        )
      ) {
        throw new Error(
          `Circular dependency detected for model ${parent.type} for row ${JSON.stringify(parentRow)}`,
        );
      }

      // create the parent statement
      createStatement({
        ...ctx,
        modelName: parent.type,
        row: parentRow,
      });
    }

    // create the statement for the current model
    const isGeneratedId =
      model.fields.filter((f) => f.isGenerated && f.isId).length > 0;

    const insertStatementTemplate = [
      "INSERT INTO %I.%I (%I)",
      isGeneratedId ? "OVERRIDING SYSTEM VALUE" : undefined,
      "VALUES (%L)",
    ]
      .filter((s) => Boolean(s))
      .join(" ");
    console.log({ row: ctx.row });
    const insertStatement = format(
      insertStatementTemplate,
      model.schemaName,
      model.tableName,
      scalars.map((f) => f.columnName),
      scalars.map((f) => serializeToSQL(f.type, ctx.row[f.name] as Json)),
    );

    ctx.statements.push(insertStatement);

    // remove the row from pending and add it to inserted
    ctx.pending[ctx.modelName] = ctx.pending[ctx.modelName].filter((r) =>
      rowIdFields.every(([k, v]) => r[k] !== v),
    );
    ctx.inserted[ctx.modelName].push(ctx.row);
  }
}
