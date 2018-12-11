import {filePathToPseudoNamespace, normaliseFieldObjectName, replaceProtoSuffix, getPathToRoot} from "../util";
import {ExportMap} from "../ExportMap";
import {Printer} from "../Printer";
import {CodePrinter} from "../CodePrinter";
import {
    FileDescriptorProto, MethodDescriptorProto,
    ServiceDescriptorProto
} from "google-protobuf/google/protobuf/descriptor_pb";
import {WellKnownTypesMap} from "../WellKnown";
import {getFieldType, MESSAGE_TYPE} from "../ts/FieldTypes";
import {CodeGeneratorResponse} from "google-protobuf/google/protobuf/compiler/plugin_pb";

export function generateJSONRPCService(filename: string, descriptor: FileDescriptorProto, exportMap: ExportMap): CodeGeneratorResponse.File[] {
    return [
        createFile(generateTypescriptDefinition(descriptor, exportMap), `${filename}_service.ts`),
    ];
}

function createFile(output: string, filename: string): CodeGeneratorResponse.File {
    const file = new CodeGeneratorResponse.File();
    file.setName(filename);
    file.setContent(output);
    return file;
}

type CallingTypes = {
    requestType: string
    responseType: string
};

function getCallingTypes(method: MethodDescriptorProto, exportMap: ExportMap): CallingTypes {
    return {
        requestType: getFieldType(MESSAGE_TYPE, method.getInputType().slice(1), "", exportMap),
        responseType: getFieldType(MESSAGE_TYPE, method.getOutputType().slice(1), "", exportMap),
    };
}

function isUsed(fileDescriptor: FileDescriptorProto, pseudoNamespace: string, exportMap: ExportMap) {
    return fileDescriptor.getServiceList().some(service => {
        return service.getMethodList().some(method => {
            const callingTypes = getCallingTypes(method, exportMap);
            const namespacePackage = pseudoNamespace + ".";
            return (
                callingTypes.requestType.indexOf(namespacePackage) === 0 ||
                callingTypes.responseType.indexOf(namespacePackage) === 0
            );
        });
    });
}

type ImportDescriptor = {
    readonly namespace: string
    readonly path: string
};

type RPCMethodDescriptor = {
    readonly nameAsPascalCase: string,
    readonly nameAsCamelCase: string,
    readonly functionName: string,
    readonly serviceName: string,
    readonly requestStream: boolean
    readonly responseStream: boolean
    readonly requestType: string
    readonly responseType: string
};

class RPCDescriptor {
    private readonly protoService: ServiceDescriptorProto;
    private readonly exportMap: ExportMap;

    constructor(protoService: ServiceDescriptorProto, exportMap: ExportMap) {
        this.protoService = protoService;
        this.exportMap = exportMap;
    }

    get name(): string {
        return this.protoService.getName();
    }

    get methods(): RPCMethodDescriptor[] {
        return this.protoService.getMethodList()
            .map(method => {
                const callingTypes = getCallingTypes(method, this.exportMap);
                const nameAsCamelCase = method.getName()[0].toLowerCase() + method.getName().substr(1);
                return {
                    nameAsPascalCase: method.getName(),
                    nameAsCamelCase,
                    functionName: normaliseFieldObjectName(method.getName()),
                    serviceName: this.name,
                    requestStream: method.getClientStreaming(),
                    responseStream: method.getServerStreaming(),
                    requestType: callingTypes.requestType,
                    responseType: callingTypes.responseType,
                };
            });
    }
}

class RPCServiceDescriptor {
    private readonly fileDescriptor: FileDescriptorProto;
    private readonly exportMap: ExportMap;
    private readonly pathToRoot: string;

    constructor(fileDescriptor: FileDescriptorProto, exportMap: ExportMap) {
        this.fileDescriptor = fileDescriptor;
        this.exportMap = exportMap;
        this.pathToRoot = getPathToRoot(fileDescriptor.getName());
    }

    get filename(): string {
        return this.fileDescriptor.getName();
    }

    get packageName(): string {
        return this.fileDescriptor.getPackage();
    }

    get imports(): ImportDescriptor[] {
        const dependencies = this.fileDescriptor.getDependencyList()
            .filter(dependency => isUsed(this.fileDescriptor, filePathToPseudoNamespace(dependency), this.exportMap))
            .map(dependency => {
                const namespace = filePathToPseudoNamespace(dependency);
                if (dependency in WellKnownTypesMap) {
                    return {
                        namespace,
                        path: WellKnownTypesMap[dependency],
                    };
                } else {
                    return {
                        namespace,
                        path: `${this.pathToRoot}${replaceProtoSuffix(replaceProtoSuffix(dependency))}`
                    };
                }
            });
        const hostProto = {
            namespace: filePathToPseudoNamespace(this.filename),
            path: `${this.pathToRoot}${replaceProtoSuffix(this.filename)}`,
        };
        return [hostProto].concat(dependencies);
    }

    get services(): RPCDescriptor[] {
        return this.fileDescriptor.getServiceList()
            .map(service => {
                return new RPCDescriptor(service, this.exportMap);
            });
    }
}

function generateTypescriptDefinition(fileDescriptor: FileDescriptorProto, exportMap: ExportMap) {
    const serviceDescriptor = new RPCServiceDescriptor(fileDescriptor, exportMap);
    const outPrinter = new Printer(0);
    const printer = new CodePrinter(0, outPrinter);

    // Header.
    printer.printLn(`// package: ${serviceDescriptor.packageName}`);
    printer.printLn(`// file: ${serviceDescriptor.filename}`);
    printer.printEmptyLn();

    if (serviceDescriptor.services.length === 0) {
        return outPrinter.getOutput();
    }

    // Import statements.
    serviceDescriptor.imports
        .forEach(importDescriptor => {
            printer.printLn(`import * as ${importDescriptor.namespace} from "${importDescriptor.path}";`);
        });
    printer.printLn(`import {HttpClient} from "@angular/common/http";`);
    printer.printLn(`import {Observable, throwError} from "rxjs";`);
    printer.printLn(`import {catchError, map} from "rxjs/operators";`);
    printer.printEmptyLn();

    printer.printLn(`export namespace ${serviceDescriptor.services[0].name} {`).indent(); // namespace

    printer.printLn(`class JsonRPCRequest {`).indent();
    printer.printLn(`public jsonrpc: string;`);
    printer.printLn(`public id: string;`);
    printer.printLn(`public method: string;`);
    printer.printLn(`public params: any;`).dedent();
    printer.printLn(`}`);
    printer.printEmptyLn();

    printer.printLn(`type JsonRPCResponse = {`).indent();
    printer.printLn(`readonly result: any;`);
    printer.printLn(`readonly id: string;`);
    printer.printLn("readonly jsonrpc: string;").dedent();
    printer.printLn(`}`);
    printer.printEmptyLn();

    // Services.
    serviceDescriptor.services
        .forEach(service => {
            // Method Type Definitions
            service.methods.forEach(method => {
                printer.printLn(`type ${method.serviceName}${method.nameAsPascalCase} = {`).indent();
                printer.printLn(`readonly methodName: string;`);
                printer.printLn(`readonly service: typeof ${method.serviceName};`);
                printer.printLn(`readonly requestType: typeof ${method.requestType};`);
                printer.printLn(`readonly responseType: typeof ${method.responseType};`);
                printer.dedent().printLn(`};`);
                printer.printEmptyLn();
            });

            printer.printLn(`class ${service.name} {`).indent();
            printer.printLn(`static readonly serviceName: string;`);
            service.methods.forEach(method => {
                printer.printLn(`static readonly ${method.nameAsPascalCase}: ${method.serviceName}${method.nameAsPascalCase};`);
            });

            printer.dedent().printLn(`}`);
            printer.printEmptyLn();
        });


    // Add a client stub that talks with the grpc-web-client library
    serviceDescriptor.services
        .forEach(service => {
            printServiceStubTypes(outPrinter, service);
            printer.printEmptyLn();
        });

    printer.dedent().printLn("}");
    return outPrinter.getOutput();
}

function printServiceStubTypes(methodPrinter: Printer, service: RPCDescriptor) {
    const printer = new CodePrinter(1, methodPrinter);

    printer
        .printLn(`export class Client {`).indent()
        .printLn(`private serviceHost: string;`)
        .printEmptyLn()
        .printLn(`constructor(serviceHost: string, private http: HttpClient) {`).indent()
        .printLn("this.serviceHost = serviceHost;").dedent()
        .printLn("}")
        .printEmptyLn()
        .printLn(`call<T>(url: string, request: any, options?: {[key: string]: string}): Observable<T> {`).indent()
        .printLn(`return this.http.post<JsonRPCResponse>(url, request, options).pipe(map(response => { return response.result; }), catchError(error => { return throwError(error); }));`).dedent()
        .printLn("}")
        .printEmptyLn()
        .printLn(`callBatch<T>(url: string, request: any, options?: {[key: string]: string}): Observable<T> {`).indent()
        .printLn(`// @ts-ignore`)
        .printLn(`return this.http.post<JsonRPCResponse[]>(url, request, options).pipe(map(response => { return response.map((r) => { return <T>r.result; }) }), catchError(error => { return throwError(error); }));`).dedent()
        .printLn("}")
        .printEmptyLn();

    service.methods.forEach((method: RPCMethodDescriptor) => {
        if (!method.requestStream && !method.responseStream) {
            // jsonrpc can't stream for now
            printUnaryStubMethodTypes(printer, service, method);
            printUnaryStubBatchMethodTypes(printer, service, method);
        }
    });
    printer.dedent().printLn("}");
}

function printUnaryStubMethodTypes(printer: CodePrinter, service: RPCDescriptor, method: RPCMethodDescriptor) {
    printer
        .printLn(`${method.functionName}(`)
        .indent().printLn(`requestMessage: ${method.requestType},`)
        .printLn(`options?: {[key: string]: string}): Observable<${method.responseType}> {`)
        .printLn(`let rpcRequest = <JsonRPCRequest>{"id": "1", "method": "${service.name}.${method.nameAsPascalCase}", "params": requestMessage, "jsonrpc": "2.0"};`)
        .printLn(`return this.call<${method.responseType}>(\`\${this.serviceHost}/rpc\`, rpcRequest, options);`).dedent()
        .printLn("}")
        .printEmptyLn();
}

function printUnaryStubBatchMethodTypes(printer: CodePrinter, service: RPCDescriptor, method: RPCMethodDescriptor) {
    printer
        .printLn(`${method.functionName}Batch(`)
        .indent().printLn(`requestMessages: ${method.requestType}[],`)
        .printLn(`options?: {[key: string]: string}): Observable<${method.responseType}[]> {`)
        .printLn(`let rpcRequests = requestMessages.map((r) => {return <JsonRPCRequest>{"id": "1", "method": "${service.name}.${method.nameAsPascalCase}", "params": r, "jsonrpc": "2.0"};});`)
        .printLn(`return this.callBatch<${method.responseType}[]>(\`\${this.serviceHost}/rpc\`, rpcRequests, options);`).dedent()
        .printLn("}")
        .printEmptyLn();
}

