import { z } from 'zod';
export declare const StageId: z.ZodString;
export declare const SliceId: z.ZodString;
export declare const TaskId: z.ZodString;
export declare const PoId: z.ZodString;
export declare const StepType: z.ZodEnum<["command", "service_start", "service_stop", "probe"]>;
export type StepType = z.infer<typeof StepType>;
export declare const RuntimeProofStep: z.ZodObject<{
    id: z.ZodString;
    type: z.ZodDefault<z.ZodOptional<z.ZodEnum<["command", "service_start", "service_stop", "probe"]>>>;
    executable: z.ZodString;
    args: z.ZodArray<z.ZodString, "many">;
    cwd: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    timeout_ms: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
    readiness_signal: z.ZodOptional<z.ZodString>;
    service_ref: z.ZodOptional<z.ZodString>;
    expected_observation: z.ZodOptional<z.ZodString>;
    not_applicable: z.ZodOptional<z.ZodObject<{
        reason: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        reason: string;
    }, {
        reason: string;
    }>>;
    expected: z.ZodOptional<z.ZodObject<{
        exit_code: z.ZodOptional<z.ZodNumber>;
        output_contains: z.ZodOptional<z.ZodString>;
        output_matches: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        exit_code?: number | undefined;
        output_contains?: string | undefined;
        output_matches?: string | undefined;
    }, {
        exit_code?: number | undefined;
        output_contains?: string | undefined;
        output_matches?: string | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    type: "command" | "service_start" | "service_stop" | "probe";
    id: string;
    executable: string;
    args: string[];
    cwd: string;
    timeout_ms: number;
    expected?: {
        exit_code?: number | undefined;
        output_contains?: string | undefined;
        output_matches?: string | undefined;
    } | undefined;
    readiness_signal?: string | undefined;
    service_ref?: string | undefined;
    expected_observation?: string | undefined;
    not_applicable?: {
        reason: string;
    } | undefined;
}, {
    id: string;
    executable: string;
    args: string[];
    expected?: {
        exit_code?: number | undefined;
        output_contains?: string | undefined;
        output_matches?: string | undefined;
    } | undefined;
    type?: "command" | "service_start" | "service_stop" | "probe" | undefined;
    cwd?: string | undefined;
    timeout_ms?: number | undefined;
    readiness_signal?: string | undefined;
    service_ref?: string | undefined;
    expected_observation?: string | undefined;
    not_applicable?: {
        reason: string;
    } | undefined;
}>;
export type RuntimeProofStep = z.infer<typeof RuntimeProofStep>;
export declare const ProofObligation: z.ZodObject<{
    po_id: z.ZodString;
    behavior: z.ZodString;
    public_seam: z.ZodString;
    oracle_source: z.ZodString;
    success_criteria: z.ZodString;
    failure_criteria: z.ZodOptional<z.ZodString>;
    required_observation: z.ZodOptional<z.ZodString>;
    applicable_risk_facts: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    po_id: string;
    behavior: string;
    public_seam: string;
    oracle_source: string;
    success_criteria: string;
    failure_criteria?: string | undefined;
    required_observation?: string | undefined;
    applicable_risk_facts?: string[] | undefined;
}, {
    po_id: string;
    behavior: string;
    public_seam: string;
    oracle_source: string;
    success_criteria: string;
    failure_criteria?: string | undefined;
    required_observation?: string | undefined;
    applicable_risk_facts?: string[] | undefined;
}>;
export type ProofObligation = z.infer<typeof ProofObligation>;
export declare const Slice: z.ZodObject<{
    slice_id: z.ZodString;
    goal: z.ZodString;
    observable_outcome: z.ZodString;
    public_seam: z.ZodString;
    dependencies: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
    proof_obligations: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodObject<{
        po_id: z.ZodString;
        behavior: z.ZodString;
        public_seam: z.ZodString;
        oracle_source: z.ZodString;
        success_criteria: z.ZodString;
        failure_criteria: z.ZodOptional<z.ZodString>;
        required_observation: z.ZodOptional<z.ZodString>;
        applicable_risk_facts: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        po_id: string;
        behavior: string;
        public_seam: string;
        oracle_source: string;
        success_criteria: string;
        failure_criteria?: string | undefined;
        required_observation?: string | undefined;
        applicable_risk_facts?: string[] | undefined;
    }, {
        po_id: string;
        behavior: string;
        public_seam: string;
        oracle_source: string;
        success_criteria: string;
        failure_criteria?: string | undefined;
        required_observation?: string | undefined;
        applicable_risk_facts?: string[] | undefined;
    }>, "many">>>;
    tasks: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
    risk_facts: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
    scv_minimum_level: z.ZodDefault<z.ZodOptional<z.ZodEnum<["lite", "standard", "enhanced"]>>>;
}, "strip", z.ZodTypeAny, {
    public_seam: string;
    slice_id: string;
    goal: string;
    observable_outcome: string;
    dependencies: string[];
    proof_obligations: {
        po_id: string;
        behavior: string;
        public_seam: string;
        oracle_source: string;
        success_criteria: string;
        failure_criteria?: string | undefined;
        required_observation?: string | undefined;
        applicable_risk_facts?: string[] | undefined;
    }[];
    tasks: string[];
    risk_facts: string[];
    scv_minimum_level: "lite" | "standard" | "enhanced";
}, {
    public_seam: string;
    slice_id: string;
    goal: string;
    observable_outcome: string;
    dependencies?: string[] | undefined;
    proof_obligations?: {
        po_id: string;
        behavior: string;
        public_seam: string;
        oracle_source: string;
        success_criteria: string;
        failure_criteria?: string | undefined;
        required_observation?: string | undefined;
        applicable_risk_facts?: string[] | undefined;
    }[] | undefined;
    tasks?: string[] | undefined;
    risk_facts?: string[] | undefined;
    scv_minimum_level?: "lite" | "standard" | "enhanced" | undefined;
}>;
export type Slice = z.infer<typeof Slice>;
export declare const Manifest: z.ZodObject<{
    stage_id: z.ZodString;
    source_path: z.ZodString;
    source_digest: z.ZodString;
    stage_goal: z.ZodString;
    outcomes: z.ZodArray<z.ZodString, "many">;
    slices: z.ZodArray<z.ZodObject<{
        slice_id: z.ZodString;
        goal: z.ZodString;
        observable_outcome: z.ZodString;
        public_seam: z.ZodString;
        dependencies: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
        proof_obligations: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodObject<{
            po_id: z.ZodString;
            behavior: z.ZodString;
            public_seam: z.ZodString;
            oracle_source: z.ZodString;
            success_criteria: z.ZodString;
            failure_criteria: z.ZodOptional<z.ZodString>;
            required_observation: z.ZodOptional<z.ZodString>;
            applicable_risk_facts: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        }, "strip", z.ZodTypeAny, {
            po_id: string;
            behavior: string;
            public_seam: string;
            oracle_source: string;
            success_criteria: string;
            failure_criteria?: string | undefined;
            required_observation?: string | undefined;
            applicable_risk_facts?: string[] | undefined;
        }, {
            po_id: string;
            behavior: string;
            public_seam: string;
            oracle_source: string;
            success_criteria: string;
            failure_criteria?: string | undefined;
            required_observation?: string | undefined;
            applicable_risk_facts?: string[] | undefined;
        }>, "many">>>;
        tasks: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
        risk_facts: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
        scv_minimum_level: z.ZodDefault<z.ZodOptional<z.ZodEnum<["lite", "standard", "enhanced"]>>>;
    }, "strip", z.ZodTypeAny, {
        public_seam: string;
        slice_id: string;
        goal: string;
        observable_outcome: string;
        dependencies: string[];
        proof_obligations: {
            po_id: string;
            behavior: string;
            public_seam: string;
            oracle_source: string;
            success_criteria: string;
            failure_criteria?: string | undefined;
            required_observation?: string | undefined;
            applicable_risk_facts?: string[] | undefined;
        }[];
        tasks: string[];
        risk_facts: string[];
        scv_minimum_level: "lite" | "standard" | "enhanced";
    }, {
        public_seam: string;
        slice_id: string;
        goal: string;
        observable_outcome: string;
        dependencies?: string[] | undefined;
        proof_obligations?: {
            po_id: string;
            behavior: string;
            public_seam: string;
            oracle_source: string;
            success_criteria: string;
            failure_criteria?: string | undefined;
            required_observation?: string | undefined;
            applicable_risk_facts?: string[] | undefined;
        }[] | undefined;
        tasks?: string[] | undefined;
        risk_facts?: string[] | undefined;
        scv_minimum_level?: "lite" | "standard" | "enhanced" | undefined;
    }>, "many">;
    dependencies: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
    risk_facts: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
    runtime_proof: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        type: z.ZodDefault<z.ZodOptional<z.ZodEnum<["command", "service_start", "service_stop", "probe"]>>>;
        executable: z.ZodString;
        args: z.ZodArray<z.ZodString, "many">;
        cwd: z.ZodDefault<z.ZodOptional<z.ZodString>>;
        timeout_ms: z.ZodDefault<z.ZodOptional<z.ZodNumber>>;
        readiness_signal: z.ZodOptional<z.ZodString>;
        service_ref: z.ZodOptional<z.ZodString>;
        expected_observation: z.ZodOptional<z.ZodString>;
        not_applicable: z.ZodOptional<z.ZodObject<{
            reason: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            reason: string;
        }, {
            reason: string;
        }>>;
        expected: z.ZodOptional<z.ZodObject<{
            exit_code: z.ZodOptional<z.ZodNumber>;
            output_contains: z.ZodOptional<z.ZodString>;
            output_matches: z.ZodOptional<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            exit_code?: number | undefined;
            output_contains?: string | undefined;
            output_matches?: string | undefined;
        }, {
            exit_code?: number | undefined;
            output_contains?: string | undefined;
            output_matches?: string | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        type: "command" | "service_start" | "service_stop" | "probe";
        id: string;
        executable: string;
        args: string[];
        cwd: string;
        timeout_ms: number;
        expected?: {
            exit_code?: number | undefined;
            output_contains?: string | undefined;
            output_matches?: string | undefined;
        } | undefined;
        readiness_signal?: string | undefined;
        service_ref?: string | undefined;
        expected_observation?: string | undefined;
        not_applicable?: {
            reason: string;
        } | undefined;
    }, {
        id: string;
        executable: string;
        args: string[];
        expected?: {
            exit_code?: number | undefined;
            output_contains?: string | undefined;
            output_matches?: string | undefined;
        } | undefined;
        type?: "command" | "service_start" | "service_stop" | "probe" | undefined;
        cwd?: string | undefined;
        timeout_ms?: number | undefined;
        readiness_signal?: string | undefined;
        service_ref?: string | undefined;
        expected_observation?: string | undefined;
        not_applicable?: {
            reason: string;
        } | undefined;
    }>, "many">>>;
    compiled_at: z.ZodOptional<z.ZodString>;
    compiled_by: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    dependencies: string[];
    risk_facts: string[];
    stage_id: string;
    source_path: string;
    source_digest: string;
    stage_goal: string;
    outcomes: string[];
    slices: {
        public_seam: string;
        slice_id: string;
        goal: string;
        observable_outcome: string;
        dependencies: string[];
        proof_obligations: {
            po_id: string;
            behavior: string;
            public_seam: string;
            oracle_source: string;
            success_criteria: string;
            failure_criteria?: string | undefined;
            required_observation?: string | undefined;
            applicable_risk_facts?: string[] | undefined;
        }[];
        tasks: string[];
        risk_facts: string[];
        scv_minimum_level: "lite" | "standard" | "enhanced";
    }[];
    runtime_proof: {
        type: "command" | "service_start" | "service_stop" | "probe";
        id: string;
        executable: string;
        args: string[];
        cwd: string;
        timeout_ms: number;
        expected?: {
            exit_code?: number | undefined;
            output_contains?: string | undefined;
            output_matches?: string | undefined;
        } | undefined;
        readiness_signal?: string | undefined;
        service_ref?: string | undefined;
        expected_observation?: string | undefined;
        not_applicable?: {
            reason: string;
        } | undefined;
    }[];
    compiled_at?: string | undefined;
    compiled_by?: string | undefined;
}, {
    stage_id: string;
    source_path: string;
    source_digest: string;
    stage_goal: string;
    outcomes: string[];
    slices: {
        public_seam: string;
        slice_id: string;
        goal: string;
        observable_outcome: string;
        dependencies?: string[] | undefined;
        proof_obligations?: {
            po_id: string;
            behavior: string;
            public_seam: string;
            oracle_source: string;
            success_criteria: string;
            failure_criteria?: string | undefined;
            required_observation?: string | undefined;
            applicable_risk_facts?: string[] | undefined;
        }[] | undefined;
        tasks?: string[] | undefined;
        risk_facts?: string[] | undefined;
        scv_minimum_level?: "lite" | "standard" | "enhanced" | undefined;
    }[];
    dependencies?: string[] | undefined;
    risk_facts?: string[] | undefined;
    runtime_proof?: {
        id: string;
        executable: string;
        args: string[];
        expected?: {
            exit_code?: number | undefined;
            output_contains?: string | undefined;
            output_matches?: string | undefined;
        } | undefined;
        type?: "command" | "service_start" | "service_stop" | "probe" | undefined;
        cwd?: string | undefined;
        timeout_ms?: number | undefined;
        readiness_signal?: string | undefined;
        service_ref?: string | undefined;
        expected_observation?: string | undefined;
        not_applicable?: {
            reason: string;
        } | undefined;
    }[] | undefined;
    compiled_at?: string | undefined;
    compiled_by?: string | undefined;
}>;
export type Manifest = z.infer<typeof Manifest>;
export declare const ScvVerdict: z.ZodEnum<["PASS", "REPAIR", "REPLAN", "BLOCKED", "ESCALATION_REQUIRED"]>;
export declare const ScvReceipt: z.ZodObject<{
    slice_id: z.ZodString;
    snapshot: z.ZodString;
    scv_level: z.ZodEnum<["lite", "standard", "enhanced"]>;
    verdict: z.ZodEnum<["PASS", "REPAIR", "REPLAN", "BLOCKED", "ESCALATION_REQUIRED"]>;
    failed_po_ids: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
    invalid_tests: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
    counterexamples: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
    scope_violations: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
    timestamp: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    slice_id: string;
    snapshot: string;
    scv_level: "lite" | "standard" | "enhanced";
    verdict: "PASS" | "REPAIR" | "REPLAN" | "BLOCKED" | "ESCALATION_REQUIRED";
    failed_po_ids: string[];
    invalid_tests: string[];
    counterexamples: string[];
    scope_violations: string[];
    timestamp?: string | undefined;
}, {
    slice_id: string;
    snapshot: string;
    scv_level: "lite" | "standard" | "enhanced";
    verdict: "PASS" | "REPAIR" | "REPLAN" | "BLOCKED" | "ESCALATION_REQUIRED";
    failed_po_ids?: string[] | undefined;
    invalid_tests?: string[] | undefined;
    counterexamples?: string[] | undefined;
    scope_violations?: string[] | undefined;
    timestamp?: string | undefined;
}>;
export type ScvReceipt = z.infer<typeof ScvReceipt>;
export declare const StageGateVerdict: z.ZodEnum<["PASS", "FAIL", "BLOCKED"]>;
export declare const StageGateReceipt: z.ZodObject<{
    stage_id: z.ZodString;
    snapshot: z.ZodString;
    platform: z.ZodString;
    verdict: z.ZodEnum<["PASS", "FAIL", "BLOCKED"]>;
    steps: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        exit_code: z.ZodNumber;
        observations: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        exit_code: number;
        observations?: string | undefined;
    }, {
        id: string;
        exit_code: number;
        observations?: string | undefined;
    }>, "many">;
    timestamp: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    stage_id: string;
    snapshot: string;
    verdict: "PASS" | "BLOCKED" | "FAIL";
    platform: string;
    steps: {
        id: string;
        exit_code: number;
        observations?: string | undefined;
    }[];
    timestamp?: string | undefined;
}, {
    stage_id: string;
    snapshot: string;
    verdict: "PASS" | "BLOCKED" | "FAIL";
    platform: string;
    steps: {
        id: string;
        exit_code: number;
        observations?: string | undefined;
    }[];
    timestamp?: string | undefined;
}>;
export type StageGateReceipt = z.infer<typeof StageGateReceipt>;
