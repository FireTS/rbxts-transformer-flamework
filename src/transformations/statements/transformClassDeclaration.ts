import ts from "typescript";
import { Diagnostics } from "../../classes/diagnostics";
import { TransformState } from "../../classes/transformState";
import { DecoratorInfo, DecoratorWithNodes } from "../../types/decorators";
import { f } from "../../util/factory";
import { buildGuardFromType, buildGuardsFromType } from "../../util/functions/buildGuardFromType";
import { getSuperClasses } from "../../util/functions/getSuperClasses";

export function transformClassDeclaration(state: TransformState, node: ts.ClassDeclaration) {
	const symbol = state.getSymbol(node);
	if (!symbol || !node.name) return state.transform(node);

	const classInfo = state.classes.get(symbol);
	if (!classInfo) return state.transform(node);

	const fields: [string, f.ConvertableExpression][] = [];

	fields.push(["identifier", state.getUid(node)]);
	fields.push(["flamework:isExternal", classInfo.isExternal]);

	const constructor = node.members.find((x): x is ts.ConstructorDeclaration => f.is.constructor(x));
	if (constructor) {
		const constructorDependencies = [];
		for (const param of constructor.parameters) {
			if (!f.is.referenceType(param.type)) Diagnostics.error(param, `Expected type reference`);

			const symbol = state.getSymbol(param.type.typeName);
			const declaration = symbol?.getDeclarations()?.[0];
			if (!declaration) Diagnostics.error(param, `Could not find declaration`);

			constructorDependencies.push(state.getUid(declaration));
		}
		if (constructor.parameters.length > 0) {
			fields.push(["flamework:dependencies", constructorDependencies]);
		}
	}

	if (node.heritageClauses) {
		const implementClauses = new Array<ts.StringLiteral>();
		for (const clause of node.heritageClauses) {
			if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue;

			for (const type of clause.types) {
				if (!ts.isIdentifier(type.expression)) continue;

				const symbol = state.getSymbol(type.expression);
				const declaration = symbol?.declarations?.[0];
				if (!declaration) continue;

				implementClauses.push(f.string(state.getUid(declaration)));
			}
		}
		if (implementClauses.length > 0) {
			fields.push(["flamework:implements", f.array(implementClauses, false)]);
		}
	}

	const decorators = classInfo.decorators.filter((x): x is DecoratorWithNodes => x.type === "WithNodes");
	const decoratorIds = new Array<string>();
	const decoratorConfigs = new Map<string, ts.Expression>();
	for (const decorator of decorators) {
		const id = state.getUid(decorator.declaration);
		const config = decorator.isFlameworkDecorator
			? generateFlameworkConfig(
					state,
					node,
					decorator,
					f.is.object(decorator.arguments[0]) ? decorator.arguments[0] : f.object([]),
			  )
			: f.object({ type: "Arbitrary", arguments: decorator.arguments });

		decoratorIds.push(id);
		decoratorConfigs.set(id, config);
	}

	fields.push(["flamework:decorators", decoratorIds]);
	for (const [id, config] of decoratorConfigs) {
		fields.push([`flamework:decorators.${id}`, config]);
	}

	const importIdentifier = state.addFileImport(state.getSourceFile(node), "@flamework/core", "Reflect");
	const realFields = fields.map(([name, value]) =>
		f.statement(f.call(f.field(importIdentifier, "defineMetadata"), [node.name!, name, value])),
	);
	ts.addSyntheticLeadingComment(
		realFields[0],
		ts.SyntaxKind.SingleLineCommentTrivia,
		`(Flamework) ${node.name.text} metadata`,
	);

	return [state.transform(f.update.classDeclaration(node, node.name, node.members, undefined)), ...realFields];
}

function calculateOmittedGuards(
	state: TransformState,
	classDeclaration: ts.ClassDeclaration,
	customAttributes?: ts.ObjectLiteralElementLike,
) {
	const omittedNames = new Set<string>();
	if (f.is.propertyAssignmentDeclaration(customAttributes) && f.is.object(customAttributes.initializer)) {
		for (const prop of customAttributes.initializer.properties) {
			if (f.is.string(prop.name) || f.is.identifier(prop.name)) {
				omittedNames.add(prop.name.text);
			}
		}
	}

	const type = state.typeChecker.getTypeAtLocation(classDeclaration);
	const property = type.getProperty("attributes");
	if (!property) return omittedNames;

	const superClass = getSuperClasses(state.typeChecker, classDeclaration)[0];
	if (!superClass) return omittedNames;

	const superType = state.typeChecker.getTypeAtLocation(superClass);
	const superProperty = superType.getProperty("attributes");
	if (!superProperty) return omittedNames;

	const attributes = state.typeChecker.getTypeOfSymbolAtLocation(property, classDeclaration);
	const superAttributes = state.typeChecker.getTypeOfSymbolAtLocation(superProperty, superClass);
	for (const { name } of superAttributes.getProperties()) {
		const prop = state.typeChecker.getTypeOfPropertyOfType(attributes, name);
		const superProp = state.typeChecker.getTypeOfPropertyOfType(superAttributes, name);

		if (prop && superProp && superProp === prop) {
			omittedNames.add(name);
		}
	}

	return omittedNames;
}

function updateAttributeGuards(
	state: TransformState,
	node: ts.ClassDeclaration,
	properties: ts.ObjectLiteralElementLike[],
) {
	const type = state.typeChecker.getTypeAtLocation(node);
	const baseComponent = state.symbolProvider.componentsFile!.get("BaseComponent");

	const property = type.getProperty("attributes");
	if (!property || property.parent !== baseComponent) return;

	const attributesType = state.typeChecker.getTypeOfSymbolAtLocation(property, node);
	if (!attributesType) return;

	const attributes = properties.find((x) => x.name && "text" in x.name && x.name.text === "attributes");
	const attributeGuards = buildGuardsFromType(state, state.getSourceFile(node), attributesType);

	const omittedGuards = calculateOmittedGuards(state, node, attributes);
	const filteredGuards = attributeGuards.filter((x) => !omittedGuards.has((x.name as ts.StringLiteral).text));
	properties = properties.filter((x) => x !== attributes);

	if (f.is.propertyAssignmentDeclaration(attributes) && f.is.object(attributes.initializer)) {
		properties.push(
			f.update.propertyAssignmentDeclaration(
				attributes,
				f.update.object(attributes.initializer, [...attributes.initializer.properties, ...filteredGuards]),
				attributes.name,
			),
		);
	} else {
		properties.push(f.propertyDeclaration("attributes", f.object(filteredGuards)));
	}

	return properties;
}

function updateInstanceGuard(
	state: TransformState,
	node: ts.ClassDeclaration,
	properties: ts.ObjectLiteralElementLike[],
) {
	const type = state.typeChecker.getTypeAtLocation(node);
	const baseComponent = state.symbolProvider.componentsFile!.get("BaseComponent");

	const property = type.getProperty("instance");
	if (!property || property.parent !== baseComponent) return;

	const superClass = getSuperClasses(state.typeChecker, node)[0];
	if (!superClass) return;

	const customGuard = properties.find((x) => x.name && "text" in x.name && x.name.text === "instanceGuard");
	if (customGuard) return;

	const instanceType = state.typeChecker.getTypeOfSymbolAtLocation(property, node);
	if (!instanceType) return;

	const superType = state.typeChecker.getTypeAtLocation(superClass);
	const superProperty = superType.getProperty("instance");
	if (!superProperty) return;

	const superInstanceType = state.typeChecker.getTypeOfSymbolAtLocation(superProperty, superClass);
	if (!superInstanceType) return;

	if (!type.checker.isTypeAssignableTo(superInstanceType, instanceType)) {
		const guard = buildGuardFromType(state, state.getSourceFile(node), instanceType);
		properties.push(f.propertyDeclaration("instanceGuard", guard));
	}

	return properties;
}

function updateComponentConfig(
	state: TransformState,
	node: ts.ClassDeclaration,
	properties: ts.ObjectLiteralElementLike[],
): ts.ObjectLiteralElementLike[] {
	properties = updateAttributeGuards(state, node, properties) ?? properties;
	properties = updateInstanceGuard(state, node, properties) ?? properties;
	return properties;
}

function generateFlameworkConfig(
	state: TransformState,
	node: ts.ClassDeclaration,
	decorator: DecoratorInfo,
	config: ts.ObjectLiteralExpression,
) {
	let properties: ts.ObjectLiteralElementLike[] = [...config.properties];

	// Automatically generate component attributes
	if (decorator.name === "Component") {
		properties = updateComponentConfig(state, node, properties);
	}

	return f.update.object(config, [f.propertyDeclaration("type", decorator.name), ...properties]);
}
