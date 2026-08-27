(ns io.github.getcolors.mysql-agy.workflow-test
  (:require [clojure.java.io :as io]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [green.cli :as green-cli]
            [io.github.getcolors.mysql-agy.tools :as tools]
            [io.github.getcolors.mysql-agy.workflow :as workflow]))

(def fixture
  (green-cli/read-state "colors.yml" (slurp "test/fixtures/colors.yml")))

(def create {:green/event :create})
(def build {:green/event :build})
(def delete {:green/event :delete})
(def health {:green/event :health})

(defn- nexts [step run-opts]
  (vec (rest (workflow/wire-fn step run-opts))))

(deftest create-forks-at-the-infrastructure-and-joins-at-the-cluster
  (is (= [:mysql-agy/infrastructure] (nexts :mysql-agy/start create)))
  (is (= [:mysql-agy/dns :mysql-agy/base] (nexts :mysql-agy/infrastructure create)))
  (testing "both branches converge on one step, so the engine joins them once"
    (is (= [:mysql-agy/cluster] (nexts :mysql-agy/dns create)))
    (is (= [:mysql-agy/cluster] (nexts :mysql-agy/base create))))
  (is (= [:mysql-agy/backup] (nexts :mysql-agy/cluster create)))
  (is (= [:mysql-agy/health] (nexts :mysql-agy/backup create)))
  (is (= [] (nexts :mysql-agy/health create))))

(deftest build-walks-the-same-graph-as-create
  (doseq [step [:mysql-agy/start :mysql-agy/infrastructure :mysql-agy/dns
                :mysql-agy/base :mysql-agy/cluster :mysql-agy/backup]]
    (is (= (nexts step create) (nexts step build)))))

(deftest delete-reads-state-first-and-destroys-in-reverse
  (is (= [:mysql-agy/load-infrastructure] (nexts :mysql-agy/start delete)))
  (is (= [:mysql-agy/cleanup] (nexts :mysql-agy/load-infrastructure delete)))
  (is (= [:mysql-agy/dns] (nexts :mysql-agy/cleanup delete)))
  (is (= [:mysql-agy/infrastructure] (nexts :mysql-agy/dns delete)))
  (is (= [] (nexts :mysql-agy/infrastructure delete))))

(deftest health-changes-nothing
  (is (= [:mysql-agy/load-infrastructure] (nexts :mysql-agy/start health)))
  (is (= [:mysql-agy/health] (nexts :mysql-agy/load-infrastructure health)))
  (is (= tools/health-step (first (workflow/wire-fn :mysql-agy/health health))))
  (testing "no stage that converges anything is reachable from health"
    (is (not-any? #{tools/infrastructure-step tools/dns-step tools/cluster-step}
                  [(first (workflow/wire-fn :mysql-agy/load-infrastructure health))
                   (first (workflow/wire-fn :mysql-agy/health health))]))))

(deftest a-build-needs-no-credential
  (is (= 0 (:green/exit (workflow/start-step (assoc fixture :green/event :build) {})))))

(deftest a-real-run-refuses-without-credentials
  (let [result (workflow/start-step (assoc fixture :green/event :create) {})]
    (is (= 2 (:green/exit result)))
    (is (str/includes? (:green/err result) "COLORS_PAR_MYSQL_ADMIN_PASSWORD"))))

(deftest a-dry-run-needs-no-credential
  (is (= 0 (:green/exit (workflow/start-step
                         (assoc fixture :green/event :create :green/dry-run true)
                         {})))))

(deftest the-profile-parameter-is-refused-before-anything-else
  (let [result (workflow/start-step (assoc fixture :green/event :build)
                                    {"COLORS_PAR_PROFILE" "elsewhere"})]
    (is (= 2 (:green/exit result)))
    (is (str/includes? (:green/err result) "COLORS_PAR_PROFILE"))))

(deftest the-destroy-guard-holds
  (let [opts (merge fixture {:green/event :delete
                             :mysql-admin-password "a"
                             :mysql-replication-password "b"
                             :backup-r2-access-key-id "c"
                             :backup-r2-secret-access-key "d"
                             :do-token "e"
                             :cloudflare-api-token "f"})
        result (workflow/start-step opts {})]
    (is (= 2 (:green/exit result)))
    (is (str/includes? (:green/err result) "COMPUTE_PREVENT_DESTROY")))
  (testing "and lifts for exactly one run"
    (is (= 0 (:green/exit
              (workflow/start-step
               (merge fixture {:green/event :delete
                               :compute-prevent-destroy false
                               :mysql-admin-password "a"
                               :mysql-replication-password "b"
                               :backup-r2-access-key-id "c"
                               :backup-r2-secret-access-key "d"
                               :do-token "e"
                               :cloudflare-api-token "f"})
               {}))))))

(deftest defaults-do-not-quietly-permit-destruction
  (is (true? (:compute-prevent-destroy workflow/defaults))))

(deftest every-side-effecting-step-is-skipped-by-dry-run
  (let [wired (fn [event]
                (set (keep (fn [step]
                             (when (try (workflow/wire-fn step {:green/event event})
                                        (catch Throwable _ nil))
                               step))
                           workflow/side-effecting)))]
    (doseq [event [:create :delete :health]]
      (is (every? (set workflow/side-effecting) (wired event))))))

(deftest a-whole-build-renders-every-stage
  (let [dir (str (java.nio.file.Files/createTempDirectory
                  "mysql-agy-build" (into-array java.nio.file.attribute.FileAttribute [])))
        result (green-cli/run-cli workflow/workflow
                                  ["build" "-f" "test/fixtures/colors.yml"]
                                  {:default-file "colors.yml"})
        _ (is (= 0 (:green/exit result)))
        root (io/file "test/fixtures/.colors/mysql-agy-fixture")]
    (io/delete-file (io/file dir) true)
    (doseq [stage ["mysql-agy-infrastructure" "mysql-agy-dns" "mysql-agy-ansible"]]
      (is (.isDirectory (io/file root stage)) stage))
    (testing "the backend is written by advice, before the stage runs"
      (is (.exists (io/file root "mysql-agy-infrastructure" "backend.tf.json")))
      (is (.exists (io/file root "mysql-agy-dns" "backend.tf.json"))))
    (testing "nothing that looks like a credential is written"
      (doseq [f (file-seq root) :when (.isFile f)]
        (is (not (re-find #"REPLACE_ME|BEGIN [A-Z ]*PRIVATE KEY" (slurp f)))
            (str f))))))
