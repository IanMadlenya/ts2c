import * as ts from 'typescript';

export type CType = string | StructType | ArrayType;
export const UniversalVarType = "struct js_var *";
type PropertiesDictionary = { [propName: string]: CType };

export class ElementTypePromise {
    public resolved: boolean = false;
    constructor(
        public ident: ts.Identifier,
        public argumentExpr: ts.Node
    ) { }
}

export class ArrayType {
    constructor(
        public text: string,
        public elementType: CType,
        public capacity: number,
        public isDynamicArray: boolean
    ) { }
}

export class StructType {
    constructor(
        public text: string,
        public properties: PropertiesDictionary,
        public isDict: boolean
    ) { }
}

export class VariableInfo {
    /** Name of the variable */
    name: string;
    /** The final determined C type for this variable */
    type: CType;
    /** Contains all references to this variable */
    references: ts.Node[] = [];
    /** Where variable was declared */
    declaration: ts.VariableDeclaration;
    /** Determines if the variable requires memory allocation */
    requiresAllocation: boolean;
}

/** Internal class for storing temporary variable details */
class VariableData {
    tsType: ts.Type;
    assignmentTypes: { [type: string]: CType } = {};
    typePromises: ElementTypePromise[] = [];
    addedProperties: PropertiesDictionary = {};
    propertiesAssigned: boolean = false;
    isDynamicArray: boolean;
    isDict: boolean;
}

export class TypeHelper {
    private userStructs: { [name: string]: StructType } = {};
    public variables: { [varDeclPos: number]: VariableInfo } = {};
    private variablesData: { [varDeclPos: number]: VariableData } = {};

    constructor(private typeChecker: ts.TypeChecker) {
    }

    /** Performs initialization of variables array */
    /** Call this before using getVariableInfo */
    public figureOutVariablesAndTypes(sources: ts.SourceFile[]) {

        for (let source of sources)
            this.findVariablesRecursively(source);
        this.resolvePromisesAndFinalizeTypes();

        return Object.keys(this.userStructs).map(k => { return {
            name: k,
            properties: Object.keys(this.userStructs[k].properties)
                            .map(pk => { return {
                                name: pk,
                                type: this.userStructs[k].properties[pk]
                            }; })
                            
        }; });

    }

    /** Get information of variable specified by ts.Identifier */
    public getVariableInfo(node: ts.Node): VariableInfo {
        if (node.kind === ts.SyntaxKind.ElementAccessExpression) {
            let elemAccess = <ts.ElementAccessExpression>node;
            let symbol = this.typeChecker.getSymbolAtLocation(elemAccess.expression);
            if (symbol != null) {
                let parentVar = this.variables[symbol.valueDeclaration.pos];
                let parentVarType = parentVar && parentVar.type;
                if (parentVarType instanceof ArrayType) {
                    let varInfo = new VariableInfo();
                    varInfo.type = parentVarType.elementType;
                    return varInfo;
                }
                else if (parentVarType instanceof StructType && elemAccess.argumentExpression.kind == ts.SyntaxKind.StringLiteral) {
                    let propName = elemAccess.argumentExpression.getText().slice(1, -1);
                    let varInfo = new VariableInfo();
                    varInfo.type = parentVarType.properties[propName];
                    return varInfo;
                }
            }
        } else if (node.kind === ts.SyntaxKind.PropertyAccessExpression) {
            let propAccess = <ts.PropertyAccessExpression>node;
            let symbol = this.typeChecker.getSymbolAtLocation(propAccess.expression);
            if (symbol != null) {
                let parentVar = this.variables[symbol.valueDeclaration.pos];
                let parentVarType = parentVar && parentVar.type;
                if (parentVarType instanceof StructType) {
                    let propName = propAccess.name.getText();
                    let varInfo = new VariableInfo();
                    if (parentVarType.isDict)
                        varInfo.name = "DICT_GET(" + parentVar.name + ", " + propName + ")";
                    else
                        varInfo.name = parentVar.name + "->" + propName;
                    varInfo.type = parentVarType.properties[propName];
                    return varInfo;
                }
            }
        } else {
            let ident = <ts.Identifier>node;
            let symbol = this.typeChecker.getSymbolAtLocation(ident);
            if (symbol != null)
                return this.variables[symbol.valueDeclaration.pos];
        }
        return null;
    }

    /** Get textual representation of type of the parameter for inserting into the C code */
    public getTypeString(source: any) {
        
        if (source.flags != null && source.intrinsicName != null) // ts.Type
            source = this.convertType(source)
        else if (source.flags != null && source.callSignatures != null && source.constructSignatures != null) // ts.Type
            source = this.convertType(source)
        else if (source.kind != null && source.flags != null) // ts.Node
            source = this.getVariableInfo(source).type;
        else if (source.name != null && source.flags != null && source.valueDeclaration != null && source.declarations != null) //ts.Symbol
            source = this.variables[source.valueDeclaration.pos].type;

        if (source instanceof ArrayType)
            return source.text;
        else if (source instanceof StructType)
            return source.text;
        else if (typeof source === 'string')
            return source;
        else
            throw new Error("Unrecognized type source");
    }

    /** Convert ts.Type to CType */
    /** This is a simplistic implementation: when possible, use getVariableInfo instead. */
    public convertType(tsType: ts.Type, ident?: ts.Identifier): CType {
        if (!tsType || tsType.flags == ts.TypeFlags.Void)
            return "void";

        if (tsType.flags == ts.TypeFlags.String)
            return "char *";
        if (tsType.flags == ts.TypeFlags.Number)
            return "int16_t";
        if (tsType.flags == ts.TypeFlags.Boolean)
            return "uint8_t";

        if (tsType.flags & ts.TypeFlags.ObjectType && tsType.getProperties().length > 0) {
            return this.generateStructure(tsType, ident);
        }

        if (tsType.flags == ts.TypeFlags.Any)
            return "void *";

        console.log("Non-standard type: " + this.typeChecker.typeToString(tsType));
        return UniversalVarType;
    }

    private temporaryVariables: { [scopeId: string]: string[] } = {};
    private iteratorVarNames = ['i', 'j', 'k', 'l', 'm', 'n'];
    public addNewIteratorVariable(scope: ts.Node): string {
        let parentFunc = scope;
        while (parentFunc && parentFunc.kind != ts.SyntaxKind.FunctionDeclaration) {
            parentFunc = parentFunc.parent;
        }
        let scopeId = parentFunc && parentFunc.pos + 1 || 'main';
        let existingSymbolNames = this.typeChecker.getSymbolsInScope(scope, ts.SymbolFlags.Variable).map(s => s.name);
        if (!this.temporaryVariables[scopeId])
            this.temporaryVariables[scopeId] = [];
        existingSymbolNames = existingSymbolNames.concat(this.temporaryVariables[scopeId]);
        let i = 0;
        while (i < this.iteratorVarNames.length && existingSymbolNames.indexOf(this.iteratorVarNames[i]) > -1)
            i++;
        let iteratorVarName;
        if (i == this.iteratorVarNames.length) {
            i = 2;
            while (existingSymbolNames.indexOf("i_" + i) > -1)
                i++;
            iteratorVarName = "i_" + i;
        }
        else
            iteratorVarName = this.iteratorVarNames[i];
        
        this.temporaryVariables[scopeId].push(iteratorVarName);
        return iteratorVarName;
    }

    public addNewTemporaryVariable(scope: ts.Node, proposedName: string): string {
        let parentFunc = scope;
        while (parentFunc && parentFunc.kind != ts.SyntaxKind.FunctionDeclaration) {
            parentFunc = parentFunc.parent;
        }
        let scopeId = parentFunc && parentFunc.pos + 1 || 'main';
        let existingSymbolNames = this.typeChecker.getSymbolsInScope(scope, ts.SymbolFlags.Variable).map(s => s.name);
        if (!this.temporaryVariables[scopeId])
            this.temporaryVariables[scopeId] = [];
        existingSymbolNames = existingSymbolNames.concat(this.temporaryVariables[scopeId]);
        if (existingSymbolNames.indexOf(proposedName) > -1)
        {
            let i = 2;
            while (existingSymbolNames.indexOf(proposedName + "_" + i) > -1)
                i++;
            proposedName = proposedName + "_" + i;
        }
        
        this.temporaryVariables[scopeId].push(proposedName);
        return proposedName;
    }

    private findVariablesRecursively(node: ts.Node) {
        if (node.kind == ts.SyntaxKind.Identifier) {
            let symbol = this.typeChecker.getSymbolAtLocation(node);
            if (!symbol) {
                return;
            }

            let varPos = symbol.valueDeclaration.pos;
            if (!this.variables[varPos]) {
                this.variables[varPos] = new VariableInfo();
                this.variablesData[varPos] = new VariableData();
                this.variables[varPos].name = node.getText();
                this.variables[varPos].declaration = <ts.VariableDeclaration>symbol.declarations[0];
            }
            let varInfo = this.variables[varPos];
            let varData = this.variablesData[varPos];
            varInfo.references.push(node);

            if (node.parent && node.parent.kind == ts.SyntaxKind.VariableDeclaration) {
                let varDecl = <ts.VariableDeclaration>node.parent;
                if (varDecl.name.getText() == node.getText()) {
                    varData.tsType = this.typeChecker.getTypeAtLocation(varDecl.name);
                    this.addTypeToVariable(varPos, <ts.Identifier>varDecl.name, varDecl.initializer);
                    if (varDecl.initializer && varDecl.initializer.kind == ts.SyntaxKind.ObjectLiteralExpression)
                        varData.propertiesAssigned = true;
                    if (varDecl.parent && varDecl.parent.parent && varDecl.parent.parent.kind == ts.SyntaxKind.ForOfStatement) {
                        let forOfStatement = <ts.ForOfStatement>varDecl.parent.parent;
                        if (forOfStatement.initializer.kind == ts.SyntaxKind.VariableDeclarationList) {
                            let forOfInitializer = <ts.VariableDeclarationList>forOfStatement.initializer;
                            if (forOfInitializer.declarations[0].pos == varDecl.pos
                                && forOfStatement.expression.kind == ts.SyntaxKind.Identifier) {
                                varData.typePromises.push(new ElementTypePromise(<ts.Identifier>forOfStatement.expression, null));
                            }
                        }
                    }
                }
            }
            else if (node.parent && node.parent.kind == ts.SyntaxKind.BinaryExpression) {
                let binExpr = <ts.BinaryExpression>node.parent;
                if (binExpr.left.kind == ts.SyntaxKind.Identifier && binExpr.left.getText() == node.getText()) {
                    this.addTypeToVariable(varPos, <ts.Identifier>binExpr.left, binExpr.right);
                    if (binExpr.right && binExpr.right.kind == ts.SyntaxKind.ObjectLiteralExpression)
                        varData.propertiesAssigned = true;
                }
            }
            else if (node.parent && node.parent.kind == ts.SyntaxKind.PropertyAccessExpression) {
                let propAccess = <ts.PropertyAccessExpression>node.parent;
                if (propAccess.expression.pos == node.pos && propAccess.parent.kind == ts.SyntaxKind.BinaryExpression) {
                    let binExpr = <ts.BinaryExpression>propAccess.parent;
                    if (binExpr.left.pos == propAccess.pos) {
                        varData.propertiesAssigned = true;
                        let determinedType = this.determineType(<ts.Identifier>propAccess.name, binExpr.right);
                        if (!(determinedType instanceof ElementTypePromise))
                            varData.addedProperties[propAccess.name.getText()] = determinedType;
                    }
                }
                if (propAccess.expression.kind == ts.SyntaxKind.Identifier && propAccess.name.getText() == "push") {
                    varData.isDynamicArray = true;
                    let determinedType: CType | ElementTypePromise = UniversalVarType;
                    if (propAccess.parent && propAccess.parent.kind == ts.SyntaxKind.CallExpression) {
                        let call = <ts.CallExpression>propAccess.parent;
                        if (call.arguments.length == 1)
                            determinedType = this.determineType(<ts.Identifier>propAccess.expression, call.arguments[0]);
                    }
                    if (!(determinedType instanceof ElementTypePromise)) {
                        for (let atKey in varData.assignmentTypes) {
                            let at = varData.assignmentTypes[atKey];
                            if (at instanceof ArrayType && at.elementType == UniversalVarType)
                                at.elementType = determinedType;
                        }
                    }
                }
                if (propAccess.expression.kind == ts.SyntaxKind.Identifier && propAccess.name.getText() == "pop") {
                    varData.isDynamicArray = true;
                }
            }
            else if (node.parent && node.parent.kind == ts.SyntaxKind.ElementAccessExpression) {
                let elemAccess = <ts.ElementAccessExpression>node.parent;
                if (elemAccess.expression.pos == node.pos) {
                    let determinedType: CType | ElementTypePromise = UniversalVarType;
                    let isLeftHandSide = false;
                    if (elemAccess.parent && elemAccess.parent.kind == ts.SyntaxKind.BinaryExpression) {
                        let binExpr = <ts.BinaryExpression>elemAccess.parent;
                        if (binExpr.left.pos == elemAccess.pos) {
                            varData.propertiesAssigned = true;
                            determinedType = this.determineType(<ts.Identifier>elemAccess.expression, binExpr.right);
                            isLeftHandSide = true;
                        }
                    }

                    if (elemAccess.argumentExpression.kind == ts.SyntaxKind.StringLiteral) {
                        let propName = elemAccess.argumentExpression.getText().slice(1, -1);
                        varData.addedProperties[propName] = varData.addedProperties[propName] || UniversalVarType;
                        if (!(determinedType instanceof ElementTypePromise))
                            varData.addedProperties[propName] = determinedType;

                    }
                    else if (elemAccess.argumentExpression.kind == ts.SyntaxKind.NumericLiteral) {
                        if (!(determinedType instanceof ElementTypePromise)) {
                            for (let atKey in varData.assignmentTypes) {
                                let at = varData.assignmentTypes[atKey];
                                if (at instanceof ArrayType && at.elementType == UniversalVarType)
                                    at.elementType = determinedType;
                            }
                        }
                    }
                    else if (isLeftHandSide)
                        varData.isDict = true;
                }
            }
        }
        node.getChildren().forEach(c => this.findVariablesRecursively(c));
    }


    private resolvePromisesAndFinalizeTypes() {
        let firstPass = true;
        let somePromisesAreResolved;
        do {
            somePromisesAreResolved = false;

            for (let k of Object.keys(this.variables).map(k => +k)) {

                if (this.variablesData[k].typePromises.length > 0) {
                    for (let promise of this.variablesData[k].typePromises.filter(p => !p.resolved)) {
                        let accessVarInfo = this.getVariableInfo(promise.ident);
                        if (accessVarInfo != null) {
                            promise.resolved = true;
                            somePromisesAreResolved = true;
                            let accessVarType = accessVarInfo.type;
                            if (accessVarType instanceof StructType) {
                                if (promise.argumentExpr.kind == ts.SyntaxKind.StringLiteral) {
                                    let propType = accessVarType.properties[promise.argumentExpr.getText().slice(1, -1)];
                                    if (propType instanceof StructType)
                                        this.variablesData[k].assignmentTypes[propType.text] = propType;
                                    else if (propType instanceof ArrayType)
                                        this.variablesData[k].assignmentTypes[propType.text] = propType;
                                    else
                                        this.variablesData[k].assignmentTypes[propType] = propType;
                                }
                            }
                            else if (accessVarType instanceof ArrayType) {
                                this.variablesData[k].assignmentTypes[this.getTypeString(accessVarType.elementType)] = accessVarType.elementType;
                            }
                        }
                    }
                }

                let types = Object.keys(this.variablesData[k].assignmentTypes).filter(t => t != "void *" && t != UniversalVarType);
                if (types.length == 1) {
                    let varType = this.variablesData[k].assignmentTypes[types[0]];
                    if (varType instanceof ArrayType && this.variablesData[k].isDynamicArray) {
                        this.variables[k].requiresAllocation = true;
                        let elementTypeText = this.getTypeString(varType.elementType);
                        elementTypeText = elementTypeText.replace(/^static /,'').replace(/\{var\}\[\d+]$/,'*');
                        varType.text = "ARRAY(" + elementTypeText + ")";
                        varType.isDynamicArray = true;
                    } else if (varType instanceof StructType && this.variablesData[k].propertiesAssigned) {
                        this.variables[k].requiresAllocation = true;
                    }
                    if (varType instanceof StructType) {
                        for (let addPropKey in this.variablesData[k].addedProperties) {
                            varType.properties[addPropKey] = this.variablesData[k].addedProperties[addPropKey];
                        }
                        varType.isDict = this.variablesData[k].isDict;
                    }
                    this.variables[k].type = varType;
                }
                else if (types.length == 0) {
                    this.variables[k].type = "void *";
                }
                else {
                    this.variables[k].requiresAllocation = true;
                    this.variables[k].type = UniversalVarType;
                }
            }

            if (firstPass) {
                firstPass = false;
                somePromisesAreResolved = true;
            }

        } while (somePromisesAreResolved);

    }

    private addTypeToVariable(varPos: number, left: ts.Identifier, right: ts.Node) {
        let determinedType = this.determineType(left, right);
        if (determinedType instanceof ElementTypePromise)
            this.variablesData[varPos].typePromises.push(determinedType);
        else if (determinedType instanceof ArrayType)
            this.variablesData[varPos].assignmentTypes[determinedType.text] = determinedType;
        else if (determinedType instanceof StructType)
            this.variablesData[varPos].assignmentTypes[determinedType.text] = determinedType;
        else
            this.variablesData[varPos].assignmentTypes[determinedType] = determinedType;

    }

    private determineType(left: ts.Identifier, right: ts.Node): CType | ElementTypePromise {
        let tsType = right ? this.typeChecker.getTypeAtLocation(right) : this.typeChecker.getTypeAtLocation(left);
        if (right && right.kind == ts.SyntaxKind.ObjectLiteralExpression)
            return this.generateStructure(tsType, left);
        else if (right && right.kind == ts.SyntaxKind.ArrayLiteralExpression)
            return this.determineArrayType(<ts.ArrayLiteralExpression>right);
        else if (right && right.kind == ts.SyntaxKind.ElementAccessExpression) {
            let accessExpr = <ts.ElementAccessExpression>right;
            if (accessExpr.expression.kind == ts.SyntaxKind.Identifier)
                return new ElementTypePromise(<ts.Identifier>accessExpr.expression, accessExpr.argumentExpression);
            else
                return this.convertType(tsType, left);
        }
        else
            return this.convertType(tsType, left);
    }

    private generateStructure(tsType: ts.Type, ident?: ts.Identifier): StructType {
        var structName = "struct_" + Object.keys(this.userStructs).length + "_t";
        var varName = ident && ident.getText();
        if (varName) {
            if (this.userStructs[varName + "_t"] == null)
                structName = varName + "_t";
            else {
                let i = 2;
                while (this.userStructs[varName + "_" + i + "_t"] != null)
                    i++;
                structName = varName + "_" + i + "_t";
            }
        }
        let userStructInfo: PropertiesDictionary = {};
        for (let prop of tsType.getProperties()) {
            let propTsType = this.typeChecker.getTypeOfSymbolAtLocation(prop, prop.valueDeclaration);
            let propType = this.convertType(propTsType, <ts.Identifier>prop.valueDeclaration.name);
            userStructInfo[prop.name] = propType;
        }

        let userStructCode = this.getStructureBodyString(userStructInfo);

        var found = false;
        for (var s in this.userStructs) {
            if (this.getStructureBodyString(this.userStructs[s].properties) == userStructCode) {
                structName = s;
                found = true;
                break;
            }
        }

        if (!found)
            this.userStructs[structName] = new StructType('struct ' + structName + ' *', userStructInfo, false);
        return this.userStructs[structName];
    }

    private getStructureBodyString(properties: PropertiesDictionary) {
        let userStructCode = '{\n';
        for (let propName in properties) {
            let propType = properties[propName];
            if (typeof propType === 'string')
                userStructCode += '    ' + propType + ' ' + propName + ';\n';
            else {
                let propTypeText = propType.text;
                if (propTypeText.indexOf("{var}") > -1)
                    userStructCode += '    ' + propType.text.replace(/^static /, '').replace("{var}", propName) + ';\n';
                else
                    userStructCode += '    ' + propType.text + ' ' + propName + ';\n';
            }
        }
        userStructCode += "};\n"
        return userStructCode;
    }

    private determineArrayType(arrLiteral: ts.ArrayLiteralExpression): ArrayType {
        var elementType;
        if (arrLiteral.elements.length > 0)
            elementType = this.convertType(this.typeChecker.getTypeAtLocation(arrLiteral.elements[0]));
        else
            elementType = UniversalVarType;

        var cap = arrLiteral.elements.length;
        return new ArrayType("static " + this.getTypeString(elementType) + " {var}[" + cap + "]", elementType, cap, false);
    }

}