import * as FRAGS from "@thatopen/fragments";
import * as WEBIFC from "web-ifc";
import { IDSCheck, IDSCheckResult, IDSFacetParameter } from "../types";
import { Components } from "../../../../core/Components";
import { IfcRelationsIndexer } from "../../../../ifc";
import { IDSFacet } from "./Facet";
import { getParameterXML } from "../exporters/parameter";

// https://github.com/buildingSMART/IDS/blob/development/Documentation/UserManual/property-facet.md

export class IDSProperty extends IDSFacet {
  propertySet: IDSFacetParameter;
  baseName: IDSFacetParameter;
  value?: IDSFacetParameter;
  dataType?: string;
  uri?: string;

  private _unsupportedTypes = [
    WEBIFC.IFCCOMPLEXPROPERTY,
    WEBIFC.IFCPHYSICALCOMPLEXQUANTITY,
  ];

  constructor(
    components: Components,
    propertySet: IDSFacetParameter,
    baseName: IDSFacetParameter,
  ) {
    super(components);
    this.propertySet = propertySet;
    this.baseName = baseName;
  }

  serialize(type: "applicability" | "requirement") {
    const propertySetXML = getParameterXML("PropertySet", this.propertySet);
    const baseNameXML = getParameterXML("BaseName", this.baseName);
    const valueXML = getParameterXML("Value", this.value);
    const dataTypeXML = this.dataType ? `dataType=${this.dataType}` : "";
    let attributes = "";
    if (type === "requirement") {
      attributes += `cardinality="${this.cardinality}"`;
      attributes += this.uri ? `uri=${this.uri}` : "";
      attributes += this.instructions
        ? `instructions="${this.instructions}"`
        : "";
    }
    return `<ids:property ${dataTypeXML} ${attributes}>
  ${propertySetXML}
  ${baseNameXML}
  ${valueXML}
</ids:property>`;
  }

  async getEntities(
    model: FRAGS.FragmentsGroup,
    collector: FRAGS.IfcProperties = {},
  ) {
    let sets: FRAGS.IfcProperties = {};
    const psets = await model.getAllPropertiesOfType(WEBIFC.IFCPROPERTYSET);
    sets = { ...sets, ...psets };
    const qsets = await model.getAllPropertiesOfType(WEBIFC.IFCELEMENTQUANTITY);
    sets = { ...sets, ...qsets };
    if (Object.keys(sets).length === 0) return [];

    const matchingSets: number[] = [];

    for (const _setID in sets) {
      const setID = Number(_setID);
      const attrs = await model.getProperties(setID);
      if (!attrs) continue;

      const nameMatches = attrs.Name?.value === this.propertySet.parameter;
      if (!nameMatches) continue;

      let propsListName: string | undefined;
      if (attrs.type === WEBIFC.IFCPROPERTYSET) propsListName = "HasProperties";
      if (attrs.type === WEBIFC.IFCELEMENTQUANTITY)
        propsListName = "Quantities";
      if (!propsListName) continue;

      for (const handle of attrs[propsListName]) {
        const propAttrs = await model.getProperties(handle.value);
        if (!propAttrs) continue;

        const propNameMatches =
          propAttrs.Name?.value === this.baseName.parameter;
        if (!propNameMatches) continue;

        if (this.value) {
          const valueKey = Object.keys(propAttrs).find((name) =>
            name.endsWith("Value"),
          );
          if (!valueKey) continue;
          const valueMatches =
            propAttrs[valueKey].value === this.value.parameter;
          if (!valueMatches) continue;
        }

        matchingSets.push(setID);
      }
    }

    const result: number[] = [];
    const indexer = this.components.get(IfcRelationsIndexer);

    for (const setID of matchingSets) {
      const expressIDs = indexer.getEntitiesWithRelation(
        model,
        "IsDefinedBy",
        setID,
      );

      for (const expressID of expressIDs) {
        if (expressID in collector) continue;
        const attrs = await model.getProperties(expressID);
        if (!attrs) continue;
        collector[expressID] = attrs;
        result.push(expressID);
      }
    }

    return [];
  }

  async test(entities: FRAGS.IfcProperties, model: FRAGS.FragmentsGroup) {
    this.testResult = [];
    for (const _expressID in entities) {
      const expressID = Number(_expressID);
      const attrs = entities[expressID];

      const checks: IDSCheck[] = [];
      const result: IDSCheckResult = {
        guid: attrs.GlobalId?.value,
        expressID,
        pass: false,
        checks,
        cardinality: this.cardinality,
      };

      this.testResult.push(result);

      const sets = await this.getPsets(model, expressID);
      const matchingSets = sets.filter((set) => {
        const result = this.evalRequirement(
          set.Name?.value ?? null,
          this.propertySet,
          "PropertySet",
        );
        if (!result) return false;
        checks.push({
          currentValue: set.Name.value,
          parameter: "PropertySet",
          pass: true,
          requiredValue: this.propertySet.parameter,
        });
        return true;
      });

      if (matchingSets.length === 0) {
        checks.push({
          currentValue: null,
          parameter: "PropertySet",
          pass: false,
          requiredValue: this.propertySet.parameter,
        });
        continue;
      }

      for (const set of matchingSets) {
        const itemsAttrName = this.getItemsAttrName(set.type);
        if (!itemsAttrName) {
          checks.push({
            currentValue: null,
            parameter: "BaseName",
            pass: false,
            requiredValue: this.baseName.parameter,
          });
          continue;
        }

        const items = set[itemsAttrName];
        const matchingItems = items.filter((item: any) => {
          if (this._unsupportedTypes.includes(item.type)) {
            return false;
          }
          const result = this.evalRequirement(
            item.Name?.value ?? null,
            this.baseName,
            "BaseName",
          );
          if (!result) return false;
          checks.push({
            currentValue: item.Name.value,
            parameter: "BaseName",
            pass: true,
            requiredValue: this.baseName.parameter,
          });
          return true;
        });

        if (matchingItems.length === 0) {
          checks.push({
            currentValue: null,
            parameter: "BaseName",
            pass: false,
            requiredValue: this.baseName.parameter,
          });
          continue;
        }

        for (const item of matchingItems) {
          this.evalValue(item, checks);
          this.evalDataType(item, checks);
          this.evalURI();
        }
      }

      // for (const definitionID of definitions) {
      //   const definitionAttrs = await model.getProperties(definitionID);
      //   if (!definitionAttrs) continue;

      //   const psetNameMatches = this.evalRequirement(
      //     definitionAttrs.Name?.value ?? null,
      //     this.propertySet,
      //     "Property Set",
      //   );
      //   if (!psetNameMatches) continue;

      //   checks.push({
      //     currentValue: definitionAttrs.Name.value,
      //     parameter: "Property Set",
      //     pass: true,
      //     requiredValue: this.propertySet.parameter,
      //   });

      //   let propsListName: string | undefined;
      //   if (definitionAttrs.type === WEBIFC.IFCPROPERTYSET)
      //     propsListName = "HasProperties";
      //   if (definitionAttrs.type === WEBIFC.IFCELEMENTQUANTITY)
      //     propsListName = "Quantities";
      //   if (!propsListName) continue;

      //   for (const handle of definitionAttrs[propsListName]) {
      //     const propAttrs = await model.getProperties(handle.value);
      //     if (!propAttrs) continue;

      //     const baseNameMatches = this.evalRequirement(
      //       propAttrs.Name?.value ?? null,
      //       this.baseName,
      //       "Base Name",
      //     );

      //     if (!baseNameMatches) continue;

      //     checks.push({
      //       currentValue: propAttrs.Name.value,
      //       parameter: "Base Name",
      //       pass: true,
      //       requiredValue: this.baseName.parameter,
      //     });

      //     this.evalValue(propAttrs, checks);
      //   }
      // }

      result.pass = checks.every(({ pass }) => pass);
    }

    const result = [...this.testResult];
    this.testResult = [];
    return result;
  }

  private getItemsAttrName(type: number) {
    let propsListName: string | undefined;
    if (type === WEBIFC.IFCPROPERTYSET) propsListName = "HasProperties";
    if (type === WEBIFC.IFCELEMENTQUANTITY) propsListName = "Quantities";
    return propsListName;
  }

  private getValueKey(attrs: Record<string, any>) {
    return Object.keys(attrs).find(
      (name) => name.endsWith("Value") || name.endsWith("Values"),
    );
  }

  // IFCPROPERTYSET from type must be get as well
  private async getPsets(model: FRAGS.FragmentsGroup, expressID: number) {
    const sets: Record<string, any>[] = [];

    const indexer = this.components.get(IfcRelationsIndexer);
    const definitions = indexer.getEntityRelations(
      model,
      expressID,
      "IsDefinedBy",
    );
    if (!definitions) return sets;

    for (const definitionID of definitions) {
      const attrs = await model.getProperties(definitionID);
      if (!attrs) continue;

      const propsListName = this.getItemsAttrName(attrs.type);
      if (!propsListName) continue;

      const attrsClone = structuredClone(attrs);
      const props: Record<string, any>[] = [];
      for (const { value } of attrsClone[propsListName]) {
        const propAttrs = await model.getProperties(value);
        if (propAttrs) props.push(propAttrs);
      }
      attrsClone[propsListName] = props;

      sets.push(attrsClone);
    }

    return sets;
  }

  // IFCPROPERTYBOUNDEDVALUE are not supported yet
  // IFCPROPERTYTABLEVALUE are not supported yet
  // Work must to be done to convert numerical value units to IDS-nominated standard units https://github.com/buildingSMART/IDS/blob/development/Documentation/UserManual/units.md
  private evalValue(attrs: Record<string, any>, checks?: IDSCheck[]) {
    const valueKey = this.getValueKey(attrs);
    if (this.value) {
      if (!valueKey) {
        checks?.push({
          parameter: "Value",
          currentValue: null,
          pass: false,
          requiredValue: this.value.parameter,
        });
        return false;
      }

      const valueAttr = attrs[valueKey];
      const facetValue = structuredClone(this.value);
      if (valueAttr.name === "IFCLABEL" && facetValue.type === "simple") {
        facetValue.parameter = String(facetValue.parameter);
      }

      if (
        (attrs.type === WEBIFC.IFCPROPERTYLISTVALUE ||
          attrs.type === WEBIFC.IFCPROPERTYENUMERATEDVALUE) &&
        Array.isArray(valueAttr)
      ) {
        const values = valueAttr.map((value) => value.value);
        const matchingValue = valueAttr.find((value) => {
          if (!facetValue) return false;
          return this.evalRequirement(value.value, facetValue, "Value");
        });
        checks?.push({
          currentValue: values as any,
          pass: !!matchingValue,
          parameter: "Value",
          requiredValue: facetValue.parameter,
        });
        return !!matchingValue;
      }

      const result = this.evalRequirement(
        valueAttr.value,
        facetValue,
        "Value",
        checks,
      );
      return result;
    }

    if (!valueKey) return true;
    const value = attrs[valueKey];

    // IDSDocs: Values with a logical unknown always fail
    if (value.type === 3 && value.value === 2) {
      checks?.push({
        parameter: "Value",
        currentValue: null,
        pass: false,
        requiredValue: null,
      });
      return false;
    }

    // IDSDocs: An empty string is considered false
    if (value.type === 1 && value.value.trim() === "") {
      checks?.push({
        parameter: "Value",
        currentValue: "",
        pass: false,
        requiredValue: null,
      });
      return false;
    }

    return true;
  }

  private evalDataType(attrs: Record<string, any>, checks?: IDSCheck[]) {
    if (!this.dataType) return true;
    const valueKey = this.getValueKey(attrs);
    const valueAttr = attrs[valueKey as any];

    if (
      (attrs.type === WEBIFC.IFCPROPERTYLISTVALUE ||
        attrs.type === WEBIFC.IFCPROPERTYENUMERATEDVALUE) &&
      Array.isArray(valueAttr) &&
      valueAttr[0]
    ) {
      const valueType = valueAttr[0].name;
      const result = this.evalRequirement(
        valueType,
        {
          type: "simple",
          parameter: this.dataType,
        },
        "DataType",
        checks,
      );
      return result;
    }

    const result = this.evalRequirement(
      valueAttr.name,
      {
        type: "simple",
        parameter: this.dataType,
      },
      "DataType",
      checks,
    );
    return result;
  }

  private evalURI() {
    return true;
  }
}