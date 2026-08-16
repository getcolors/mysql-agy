(ns io.github.getcolors.mysql-agy.tools
  "OpenTofu and Ansible stages for the three-member Group Replication cluster."
  (:require [cheshire.core :as json]
            [clojure.string :as str]
            [clojure.walk :as walk]
            [green.ansible :as ansible]
            [green.process :as process]
            [green.providers :as provider-ops]
            [green.scaffold :as sc]
            [green.tofu :as tofu]
            [green.workflow :as wf]
            [io.github.getcolors.mysql-agy.utils :as utils]
            [io.github.getcolors.mysql-agy.validate :as validate]))

(def infrastructure-tool "mysql-agy-infrastructure")
(def dns-tool "mysql-agy-dns")
(def ansible-tool "mysql-agy-ansible")
(def tofu-tools [infrastructure-tool dns-tool])

(def ^:private root "io.github.getcolors.mysql_agy.tools")
(def ^:private template-opts sc/preserve-jinja-delimiters)

(defn template [path file] (keyword (str root "." path) file))
(defn spec [template target data]
  {:template template :target target :data data :opts template-opts})
(defn raw-spec [target content] (sc/content-spec target content))
(defn tool-dir [opts tool] (utils/tool-dir opts tool))

(defn credential-env [opts & slots]
  (provider-ops/tool-env validate/providers opts
                         (conj (vec slots) :provider-backend)))

;; ---------------------------------------------------------------------------
;; infrastructure

(def fallback-outputs
  {:node_public_ips ["192.0.2.11" "192.0.2.12" "192.0.2.13"]
   :node_private_ips ["10.110.0.11" "10.110.0.12" "10.110.0.13"]
   :node_droplet_ids [100000001 100000002 100000003]
   :reserved_ip "192.0.2.10"
   :vpc_id "00000000-0000-0000-0000-000000000000"
   :vpc_ip_range "10.110.0.0/20"})

(defn infrastructure-specs [opts]
  (let [dir (tool-dir opts infrastructure-tool)
        data (assoc opts
                    :node-count (utils/node-count opts)
                    :digitalocean-ssh-sources-json
                    (json/generate-string (:digitalocean-ssh-sources opts))
                    :digitalocean-client-sources-json
                    (json/generate-string (:digitalocean-client-sources opts)))]
    [(spec (template "infrastructure" "main.tf") (str dir "/main.tf") data)]))

(defn- outputs-map [result]
  (some-> (:mysql-agy/outputs result) walk/keywordize-keys))

(defn infrastructure-step [opts]
  (let [result (tofu/tofu-with-spec
                opts (infrastructure-specs opts)
                {:dir (tool-dir opts infrastructure-tool)
                 :env (credential-env opts :provider-compute)
                 :output-key :mysql-agy/outputs})]
    (cond
      (wf/failed? result) result
      (= :delete (:green/event opts)) result
      (= :build (:green/event opts)) (merge result fallback-outputs)
      :else (merge result fallback-outputs (outputs-map result)))))

(defn process-result [opts label {:keys [exit out err]}]
  (if (zero? exit)
    (assoc opts :green/exit 0)
    (assoc opts :green/exit (max 1 exit)
                :green/err (str label " failed: "
                                (or (not-empty err) (not-empty out) "(no output)")))))

(defn load-infrastructure-step
  "Read node addresses out of remote state without planning or changing anything."
  [opts]
  (let [dir (tool-dir opts infrastructure-tool)
        rendered (assoc (sc/scaffold (assoc opts :green/event :build)
                                     (infrastructure-specs opts))
                        :green/event (:green/event opts))
        env (merge (into {} (System/getenv))
                   (credential-env opts :provider-compute))
        init (process/run ["tofu" (str "-chdir=" dir) "init" "-input=false" "-no-color"]
                          {:extra-env env})]
    (if-not (zero? (:exit init))
      (process-result rendered "infrastructure state initialization" init)
      (try
        (let [outputs (tofu/outputs dir env)]
          (merge rendered fallback-outputs outputs
                 {:mysql-agy/infrastructure-present? (contains? outputs :reserved_ip)}))
        (catch Throwable t
          (assoc rendered :green/exit 1
                          :green/err (str "infrastructure state output failed: "
                                          (or (ex-message t) (str (class t))))))))))

;; ---------------------------------------------------------------------------
;; shared template data

(defn nodes
  "One map per member, in ordinal order, merging desired state with infrastructure outputs."
  [opts]
  (let [data (merge fallback-outputs opts)]
    (mapv (fn [ordinal]
            (let [idx (dec ordinal)]
              {:ordinal ordinal
               :name (utils/node-name opts ordinal)
               :host (utils/node-host opts ordinal)
               :public-ip (nth (:node_public_ips data) idx nil)
               :private-ip (nth (:node_private_ips data) idx nil)
               :droplet-id (nth (:node_droplet_ids data) idx nil)
               :server-id (utils/server-id ordinal)
               :connection-server-id (utils/connection-server-id ordinal)}))
          (utils/ordinals opts))))

(defn group-seeds
  "`group_replication_group_seeds`: every member's private address on the group port."
  [opts]
  (str/join "," (map #(str (:private-ip %) ":" (:mysql-group-port opts))
                     (nodes opts))))

(defn data-fn [opts]
  (let [data (merge fallback-outputs opts)]
    (assoc data
           :node-count (utils/node-count opts)
           :backup-prefix (utils/backup-prefix opts)
           :group-seeds (group-seeds data)
           :cluster-record (utils/record-name (:cluster-host opts)))))

(defn inventory
  "Ansible inventory as JSON."
  [opts]
  (let [data (data-fn opts)
        key-file (str (:digitalocean-ssh-private-key data))
        hosts (into (sorted-map)
                    (map (fn [{:keys [name ordinal public-ip private-ip droplet-id
                                      server-id connection-server-id host]}]
                           [name (into (sorted-map)
                                       {:ansible_host public-ip
                                        :ansible_user "root"
                                        :ansible_ssh_private_key_file key-file
                                        :node_ordinal ordinal
                                        :node_host host
                                        :private_ip private-ip
                                        :droplet_id droplet-id
                                        :server_id server-id
                                        :connection_server_id connection-server-id})]))
                    (nodes data))]
    (json/generate-string
     {:all {:children
            {:mysql {:hosts hosts}
             :bootstrap {:hosts (select-keys hosts [(utils/node-name opts 1)])}}}}
     {:pretty true})))

;; ---------------------------------------------------------------------------
;; dns

(defn dns-specs [opts]
  (let [dir (tool-dir opts dns-tool)
        base (data-fn opts)
        data (assoc base
                    :node-records-json
                    (json/generate-string
                     (into (sorted-map)
                           (map (fn [{:keys [host public-ip]}]
                                  [(utils/record-name host) public-ip]))
                           (nodes base))))]
    [(spec (template "dns" "main.tf") (str dir "/main.tf") data)]))

(defn dns-step [opts]
  (tofu/tofu-with-spec opts (dns-specs opts)
                       {:dir (tool-dir opts dns-tool)
                        :env (credential-env opts :provider-dns)
                        :output-key :mysql-agy/dns-outputs}))

;; ---------------------------------------------------------------------------
;; ansible

(def ^:private playbooks
  ["base.yml" "cluster.yml" "backup.yml" "health.yml" "cleanup.yml"])

(def ^:private node-files
  ["mysql-agy-lib" "mysql-agy-endpoint" "mysql-agy-heartbeat" "mysql-agy-snapshot"
   "mysql-agy-binlog-archive" "mysql-agy-binlog-upload" "mysql-agy-restore-check"
   "mysql-agy-health" "mysqld.cnf" "verify.cnf" "apparmor-local" "node.env"])

(defn ansible-specs [opts]
  (let [dir (tool-dir opts ansible-tool)
        data (data-fn opts)]
    (concat
     [(spec (template "ansible" "ansible.cfg") (str dir "/ansible.cfg") data)]
     (map #(spec (template "ansible" %) (str dir "/" %) data) playbooks)
     (map #(spec (template "ansible.files" %) (str dir "/files/" %) data) node-files)
     [(raw-spec (str dir "/inventory.json") (inventory opts))])))

(defn- ansible-config [opts playbook recap-key]
  {:dir (tool-dir opts ansible-tool)
   :inventory "inventory.json"
   :playbooks {:create playbook :delete playbook}
   :host-key-checking false
   :recap-key recap-key})

(defn ansible-render-step
  "Render the whole Ansible directory once."
  [opts]
  (sc/scaffold opts (ansible-specs opts)))

(defn- playbook-step [opts playbook recap-key]
  (if (= :build (:green/event opts))
    (sc/scaffold opts (ansible-specs opts))
    (ansible/ansible-step (sc/scaffold (assoc opts :green/event :create)
                                       (ansible-specs opts))
                          (ansible-config opts playbook recap-key))))

(defn base-step [opts]
  (-> (playbook-step opts "base.yml" :mysql-agy/base-recap)
      (assoc :green/event (:green/event opts))))

(defn cluster-step [opts]
  (-> (playbook-step opts "cluster.yml" :mysql-agy/cluster-recap)
      (assoc :green/event (:green/event opts))))

(defn backup-step [opts]
  (-> (playbook-step opts "backup.yml" :mysql-agy/backup-recap)
      (assoc :green/event (:green/event opts))))

(defn health-step [opts]
  (-> (playbook-step opts "health.yml" :mysql-agy/health-recap)
      (assoc :green/event (:green/event opts))))

(defn cleanup-step
  "Stop the managed units before the droplets are destroyed."
  [opts]
  (if (false? (:mysql-agy/infrastructure-present? opts))
    (assoc opts :green/exit 0)
    (ansible/ansible-with-spec
     opts (ansible-config opts "cleanup.yml" :mysql-agy/cleanup-recap)
     (ansible-specs opts))))
