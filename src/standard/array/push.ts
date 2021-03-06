import * as ts from 'typescript';
import { CodeTemplate, CodeTemplateFactory, CTemplateBase } from '../../template';
import { StandardCallResolver, IResolver, IResolverMatchOptions } from '../../standard';
import { ArrayType, NumberVarType, PointerVarType, UniversalVarType } from '../../types/ctypes';
import { IScope } from '../../program';
import { CVariable } from '../../nodes/variable';
import { CExpression } from '../../nodes/expressions';
import { CElementAccess } from '../../nodes/elementaccess';
import { CAsUniversalVar } from '../../nodes/typeconvert';
import { TypeHelper } from '../../types/typehelper';

@StandardCallResolver
class ArrayPushResolver implements IResolver {
    public matchesNode(typeHelper: TypeHelper, call: ts.CallExpression, options?: IResolverMatchOptions) {
        if (call.expression.kind != ts.SyntaxKind.PropertyAccessExpression)
            return false;
        let propAccess = <ts.PropertyAccessExpression>call.expression;
        let objType = typeHelper.getCType(propAccess.expression);
        return propAccess.name.getText() == "push" && (objType && objType instanceof ArrayType && objType.isDynamicArray || options && options.determineObjectType);
    }
    public objectType(typeHelper: TypeHelper, call: ts.CallExpression) {
        let elementType = call.arguments[0] && typeHelper.getCType(call.arguments[0]);
        return new ArrayType(elementType || PointerVarType, 0, true);
    }
    public argumentTypes(typeHelper: TypeHelper, call: ts.CallExpression) {
        let propAccess = <ts.PropertyAccessExpression>call.expression;
        let objType = typeHelper.getCType(propAccess.expression);
        return call.arguments.map(a => objType instanceof ArrayType ? objType.elementType : null);
    }
    public returnType(typeHelper: TypeHelper, call: ts.CallExpression) {
        return NumberVarType;
    }
    public createTemplate(scope: IScope, node: ts.CallExpression) {
        return new CArrayPush(scope, node);
    }
    public needsDisposal(typeHelper: TypeHelper, node: ts.CallExpression) {
        return false;
    }
    public getTempVarName(typeHelper: TypeHelper, node: ts.CallExpression) {
        return null;
    }
    public getEscapeNode(typeHelper: TypeHelper, node: ts.CallExpression) {
        return (<ts.PropertyAccessExpression>node.expression).expression;
    }
}

@CodeTemplate(`
{#statements}
    {#if !topExpressionOfStatement}
        {pushValues}
        {tempVarName} = {varAccess}->size;
    {/if}
{/statements}
{#if topExpressionOfStatement}
    {pushValues}
{#else}
    {tempVarName}
{/if}`)
class CArrayPush extends CTemplateBase {
    public topExpressionOfStatement: boolean;
    public tempVarName: string = '';
    public varAccess: CElementAccess = null;
    public pushValues: CPushValue[] = [];
    constructor(scope: IScope, call: ts.CallExpression) {
        super();
        const propAccess = <ts.PropertyAccessExpression>call.expression;
        const type = <ArrayType>scope.root.typeHelper.getCType(propAccess.expression);
        this.varAccess = new CElementAccess(scope, propAccess.expression);
        const args = call.arguments.map(a => type.elementType === UniversalVarType ? new CAsUniversalVar(scope, a) : CodeTemplateFactory.createForNode(scope, a));
        this.pushValues = args.map(a => new CPushValue(scope, this.varAccess, a));
        this.topExpressionOfStatement = call.parent.kind == ts.SyntaxKind.ExpressionStatement;
        if (!this.topExpressionOfStatement) {
            this.tempVarName = scope.root.symbolsHelper.addTemp(propAccess, "arr_size");
            scope.variables.push(new CVariable(scope, this.tempVarName, NumberVarType));
        }
        scope.root.headerFlags.array = true;
    }

}

@CodeTemplate(`ARRAY_PUSH({varAccess}, {value});\n`)
class CPushValue {
    constructor(scope: IScope, public varAccess: CElementAccess, public value: CExpression) { }
}
