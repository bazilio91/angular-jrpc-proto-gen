import {
    filePathToPseudoNamespace, isProto2,
    withinNamespaceFromExportEntry, normaliseFieldObjectName
} from "../util";
import {ExportMap} from "../ExportMap";
import {
    FieldDescriptorProto, FileDescriptorProto, DescriptorProto,
    FieldOptions
} from "google-protobuf/google/protobuf/descriptor_pb";
import {MESSAGE_TYPE, BYTES_TYPE, ENUM_TYPE, getFieldType, getTypeName} from "./FieldTypes";
import {Printer} from "../Printer";
import {printEnum} from "./enum";
import {printOneOfDecl} from "./oneof";
import {printExtension} from "./extensions";
import JSType = FieldOptions.JSType;

export function printMessage(fileName: string, exportMap: ExportMap, messageDescriptor: DescriptorProto, indentLevel: number, fileDescriptor: FileDescriptorProto) {
    const messageName = messageDescriptor.getName();
    const messageOptions = messageDescriptor.getOptions();
    if (messageOptions !== undefined && messageOptions.getMapEntry()) {
        // this message type is the entry tuple for a map - don't output it
        return "";
    }


    const printer = new Printer(indentLevel);
    printer.printLn(`export class ${messageName} {`);

    const oneOfGroups: Array<Array<FieldDescriptorProto>> = [];

    messageDescriptor.getFieldList().forEach(field => {
        if (field.hasOneofIndex()) {
            const oneOfIndex = field.getOneofIndex();
            let existing = oneOfGroups[oneOfIndex];
            if (existing === undefined) {
                existing = [];
                oneOfGroups[oneOfIndex] = existing;
            }
            existing.push(field);
        }
        const type = field.getType();

        let exportType;
        const fullTypeName = field.getTypeName().slice(1);
        if (type === MESSAGE_TYPE) {
            const fieldMessageType = exportMap.getMessage(fullTypeName);
            if (fieldMessageType === undefined) {
                throw new Error("No message export for: " + fullTypeName);
            }
            if (fieldMessageType.messageOptions !== undefined && fieldMessageType.messageOptions.getMapEntry()) {
                // This field is a map
                const keyTuple = fieldMessageType.mapFieldOptions!.key;
                const keyType = keyTuple[0];
                const keyTypeName = getFieldType(keyType, keyTuple[1], fileName, exportMap);
                const valueTuple = fieldMessageType.mapFieldOptions!.value;
                const valueType = valueTuple[0];
                let valueTypeName = getFieldType(valueType, valueTuple[1], fileName, exportMap);
                if (valueType === BYTES_TYPE) {
                    valueTypeName = "Uint8Array | string";
                }
                printer.printIndentedLn(`${field.getName()}: Map<${keyTypeName}, ${valueTypeName}>;`);
                return;
            }
            const withinNamespace = withinNamespaceFromExportEntry(fullTypeName, fieldMessageType);
            if (fieldMessageType.fileName === fileName) {
                exportType = withinNamespace;
            } else {
                exportType = filePathToPseudoNamespace(fieldMessageType.fileName) + "." + withinNamespace;
            }
        } else if (type === ENUM_TYPE) {
            const fieldEnumType = exportMap.getEnum(fullTypeName);
            if (fieldEnumType === undefined) {
                throw new Error("No enum export for: " + fullTypeName);
            }
            const withinNamespace = withinNamespaceFromExportEntry(fullTypeName, fieldEnumType);
            if (fieldEnumType.fileName === fileName) {
                exportType = withinNamespace;
            } else {
                exportType = filePathToPseudoNamespace(fieldEnumType.fileName) + "." + withinNamespace;
            }
        } else {
            if (field.getOptions() && field.getOptions().hasJstype()) {
                switch (field.getOptions().getJstype()) {
                    case JSType.JS_NUMBER:
                        exportType = "number";
                        break;
                    case JSType.JS_STRING:
                        exportType = "string";
                        break;
                    default:
                        exportType = getTypeName(type);
                }
            } else {
                exportType = getTypeName(type);
            }
        }

        if (field.getLabel() === FieldDescriptorProto.Label.LABEL_REPEATED) {// is repeated
            if (type === BYTES_TYPE) {
                printer.printIndentedLn(`${field.getName()}: Array<Uint8Array | string>;`);
            } else {
                printer.printIndentedLn(`${field.getName()}: Array<${exportType}>;`);
            }
        } else {
            if (type === BYTES_TYPE) {
                printer.printIndentedLn(`${field.getName()}: Uint8Array | string;`);
            } else {
                let fieldObjectType = exportType;
                let canBeUndefined = false;
                if (type === MESSAGE_TYPE) {
                    if (!isProto2(fileDescriptor) || (field.getLabel() === FieldDescriptorProto.Label.LABEL_OPTIONAL)) {
                        canBeUndefined = true;
                    }
                } else {
                    if (isProto2(fileDescriptor)) {
                        canBeUndefined = true;
                    }
                }
                const fieldObjectName = normaliseFieldObjectName(field.getName());
                printer.printIndentedLn(`${fieldObjectName}${canBeUndefined ? "?" : ""}: ${fieldObjectType};`);
            }
        }
    });


    // printer.printIndentedLn(`toObject(includeInstance?: boolean): ${messageName}.${objectTypeName};`);


    messageDescriptor.getNestedTypeList().forEach(nested => {
        const msgOutput = printMessage(fileName, exportMap, nested, indentLevel + 1, fileDescriptor);
        if (msgOutput !== "") {
            // If the message class is a Map entry then it isn't output, so don't print the namespace block
            printer.print(msgOutput);
        }
    });
    messageDescriptor.getEnumTypeList().forEach(enumType => {
        printer.print(`${printEnum(enumType, indentLevel + 1)}`);
    });
    messageDescriptor.getOneofDeclList().forEach((oneOfDecl, index) => {
        printer.print(`${printOneOfDecl(oneOfDecl, oneOfGroups[index] || [], indentLevel + 1)}`);
    });
    messageDescriptor.getExtensionList().forEach(extension => {
        printer.print(printExtension(fileName, exportMap, extension, indentLevel + 1));
    });

    printer.printLn(`}`);

    return printer.getOutput();
}
